const { formatThread, formatThreadList, splitText, threadTitle } = require("./format");
const { redact } = require("./logger");

const DESKTOP_TURN_SETTLE_MS = 6000;

const HELP_TEXT = [
  "Команды:",
  "/chats — последние чаты Codex",
  "/current — выбранный чат",
  "/use 2 — выбрать чат из последнего списка",
  "/new Название — создать новый чат",
  "/status — состояние текущей задачи",
  "/stop — остановить текущую задачу",
  "/steer текст — уточнить выполняемую задачу",
  "/approve — разрешить ожидающее действие",
  "/deny — отклонить ожидающее действие",
  "/id — показать ваш Telegram user ID",
  "",
  "Обычный текст отправляется в выбранный чат Codex.",
].join("\n");

function extractAgentText(item) {
  if (!item) return "";
  if (typeof item.text === "string") return item.text;
  if (typeof item.message === "string") return item.message;
  if (Array.isArray(item.content)) {
    return item.content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function isAgentMessage(item) {
  return item?.type === "agentMessage" || item?.type === "agent_message";
}

function isUserMessage(item) {
  return item?.type === "userMessage" || item?.type === "user_message";
}

function isThreadBusy(thread) {
  if (thread?.status?.type === "active") return true;
  return Array.isArray(thread?.turns) && thread.turns.some((turn) => turn?.status === "inProgress");
}

function extractTurnAnswer(turn) {
  const messages = Array.isArray(turn?.items) ? turn.items.filter(isAgentMessage) : [];
  const finalMessages = messages.filter(
    (item) => item.phase === "final_answer" || item.phase === "final",
  );
  const candidates = finalMessages.length
    ? finalMessages
    : messages.filter((item) => item.phase !== "commentary");
  return candidates.map(extractAgentText).filter(Boolean).join("\n\n").trim();
}

function extractTurnUserText(turn) {
  const messages = Array.isArray(turn?.items) ? turn.items.filter(isUserMessage) : [];
  return messages.map(extractAgentText).filter(Boolean).join("\n\n").trim();
}

function isTerminalTurnStatus(status) {
  return status === "completed" || status === "interrupted" || status === "failed";
}

function shouldWaitForTurnAnswer(turn, answer, fromTelegram = false) {
  return !fromTelegram && isTerminalTurnStatus(turn?.status) && !String(answer || "").trim();
}

function isDesktopTurnSettled(firstCompletedAt, now = Date.now()) {
  return Number.isFinite(firstCompletedAt) && now - firstCompletedAt >= DESKTOP_TURN_SETTLE_MS;
}

function unseenTerminalTurns(turns, seenIds) {
  const seen = seenIds instanceof Set ? seenIds : new Set(seenIds || []);
  return (Array.isArray(turns) ? turns : [])
    .filter((turn) => turn?.id && isTerminalTurnStatus(turn.status) && !seen.has(turn.id))
    .sort((left, right) => {
      const leftTime = left.completedAt || left.startedAt || 0;
      const rightTime = right.completedAt || right.startedAt || 0;
      return leftTime - rightTime || String(left.id).localeCompare(String(right.id));
    });
}

function appendBoundedUnique(items, value, limit = 200) {
  return [...new Set([...(Array.isArray(items) ? items : []), value])].slice(-limit);
}

class CodexTelegramBot {
  constructor({ telegram, codex, stateStore, config, logger }) {
    this.telegram = telegram;
    this.codex = codex;
    this.stateStore = stateStore;
    this.state = stateStore.state;
    this.config = config;
    this.logger = logger;
    this.lastThreads = [];
    this.activeByThread = new Map();
    this.activeByTurn = new Map();
    this.pendingApprovals = new Map();
    this.desktopTurnFirstCompletedAt = new Map();
    this.desktopSyncTimer = null;
    this.desktopSyncRunning = false;
    this.desktopSyncSuspended = false;

    this.codex.on("notification", (message) => {
      this.#onCodexNotification(message).catch((error) =>
        this.logger.error("Ошибка обработки события Codex", error.stack || error.message),
      );
    });
    this.codex.on("serverRequest", (message) => {
      this.#onServerRequest(message).catch((error) =>
        this.logger.error("Ошибка обработки запроса Codex", error.stack || error.message),
      );
    });
    this.codex.on("disconnected", (error) => {
      this.#onCodexDisconnected(error).catch(() => {});
    });
    this.telegram.on("reconnected", ({ gapMs }) => {
      this.#onTelegramReconnected(gapMs).catch(() => {});
    });
  }

  async initialize() {
    await this.telegram.deleteWebhook();
    await this.telegram.setMyCommands([
      { command: "chats", description: "Список чатов Codex" },
      { command: "current", description: "Текущий чат" },
      { command: "use", description: "Сменить текущий чат" },
      { command: "new", description: "Создать новый чат" },
      { command: "status", description: "Статус задачи" },
      { command: "stop", description: "Остановить задачу" },
      { command: "approve", description: "Разрешить действие" },
      { command: "deny", description: "Отклонить действие" },
      { command: "help", description: "Справка" },
    ]);
    await this.codex.ensureStarted();
    try {
      await this.#initializeDesktopSync();
    } catch (error) {
      this.logger.warn(
        "Не удалось инициализировать синхронизацию с Codex; повторю в фоне",
        error.message,
      );
    }
    this.desktopSyncTimer = setInterval(() => {
      this.#pollDesktopAnswers().catch((error) =>
        this.logger.warn("Не удалось синхронизировать ответы Desktop", error.message),
      );
    }, this.config.desktopSyncPollMs);
    this.desktopSyncTimer.unref?.();
  }

  stop() {
    if (this.desktopSyncTimer) clearInterval(this.desktopSyncTimer);
    this.desktopSyncTimer = null;
  }

  async handleUpdate(update) {
    if (update.message) return this.#handleMessage(update.message);
    if (update.callback_query) return this.#handleCallback(update.callback_query);
  }

  #isAuthorized(userId) {
    return Number(userId) === this.config.allowedUserId;
  }

  async #handleMessage(message) {
    const userId = message.from?.id;
    const chatId = message.chat?.id;
    if (!this.#isAuthorized(userId)) {
      this.logger.warn("Отклонено сообщение от постороннего пользователя", { userId, chatId });
      await this.telegram.sendMessage(chatId, `Доступ запрещён. Ваш Telegram user ID: ${userId}`);
      return;
    }

    this.state = this.stateStore.save({ lastChatId: chatId });
    const text = typeof message.text === "string" ? message.text.trim() : "";
    if (!text) {
      await this.telegram.sendMessage(chatId, "Пока поддерживаются только текстовые сообщения.");
      return;
    }

    if (!text.startsWith("/")) {
      await this.#sendPrompt(chatId, text);
      return;
    }

    const firstSpace = text.indexOf(" ");
    const rawCommand = (firstSpace === -1 ? text : text.slice(0, firstSpace)).toLowerCase();
    const command = rawCommand.split("@")[0];
    const argument = firstSpace === -1 ? "" : text.slice(firstSpace + 1).trim();

    switch (command) {
      case "/start":
      case "/help":
        await this.telegram.sendMessage(chatId, HELP_TEXT);
        break;
      case "/id":
        await this.telegram.sendMessage(chatId, `Ваш Telegram user ID: ${userId}`);
        break;
      case "/chats":
        await this.#showChats(chatId);
        break;
      case "/current":
        await this.#showCurrent(chatId);
        break;
      case "/use":
        await this.#useThread(chatId, argument);
        break;
      case "/new":
        await this.#newThread(chatId, argument);
        break;
      case "/status":
        await this.#showStatus(chatId);
        break;
      case "/stop":
        await this.#stopTurn(chatId);
        break;
      case "/steer":
        await this.#steerTurn(chatId, argument);
        break;
      case "/approve":
        await this.#resolveApproval(chatId, true);
        break;
      case "/deny":
        await this.#resolveApproval(chatId, false);
        break;
      default:
        await this.telegram.sendMessage(chatId, `Неизвестная команда.\n\n${HELP_TEXT}`);
    }
  }

  async #handleCallback(query) {
    const userId = query.from?.id;
    const chatId = query.message?.chat?.id;
    if (!this.#isAuthorized(userId)) {
      await this.telegram.answerCallbackQuery(query.id, "Доступ запрещён");
      return;
    }

    const data = String(query.data || "");
    if (data.startsWith("use:")) {
      const threadId = data.slice(4);
      await this.#selectThread(chatId, threadId);
      await this.telegram.answerCallbackQuery(query.id, "Чат выбран");
      return;
    }
    await this.telegram.answerCallbackQuery(query.id);
  }

  async #showChats(chatId) {
    const result = await this.codex.listThreads({ limit: 10 });
    this.lastThreads = result.data || [];
    this.state = this.stateStore.save({
      lastListedThreadIds: this.lastThreads.map((thread) => thread.id),
    });
    const keyboard = this.lastThreads.map((thread, index) => [
      {
        text: `${thread.id === this.state.currentThreadId ? "●" : "○"} ${index + 1}. ${threadTitle(thread).slice(0, 45)}`,
        callback_data: `use:${thread.id}`,
      },
    ]);
    await this.telegram.sendMessage(
      chatId,
      formatThreadList(this.lastThreads, this.state.currentThreadId),
      keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {},
    );
  }

  async #showCurrent(chatId) {
    if (!this.state.currentThreadId) {
      await this.telegram.sendMessage(chatId, "Текущий чат не выбран. Используй /chats.");
      return;
    }
    const result = await this.codex.readThread(this.state.currentThreadId, false);
    await this.telegram.sendMessage(chatId, formatThread(result.thread));
  }

  async #useThread(chatId, argument) {
    if (!argument) {
      await this.telegram.sendMessage(chatId, "Укажи номер: /use 2");
      return;
    }
    if (!this.lastThreads.length) {
      const result = await this.codex.listThreads({ limit: 10 });
      this.lastThreads = result.data || [];
    }

    let thread = null;
    if (/^\d+$/.test(argument)) thread = this.lastThreads[Number(argument) - 1] || null;
    if (!thread) thread = this.lastThreads.find((item) => item.id.startsWith(argument));
    if (!thread) {
      await this.telegram.sendMessage(chatId, "Чат не найден. Обнови список командой /chats.");
      return;
    }
    await this.#selectThread(chatId, thread.id, thread);
  }

  async #selectThread(chatId, threadId, knownThread = null) {
    const thread = knownThread || (await this.codex.readThread(threadId, false)).thread;
    this.desktopSyncSuspended = true;
    this.state = this.stateStore.save({
      currentThreadId: thread.id,
      currentThreadName: threadTitle(thread),
      lastChatId: chatId,
      desktopSyncThreadId: null,
      desktopSyncSeenTurnIds: null,
    });
    try {
      await this.#resetDesktopSyncBaseline(thread.id);
    } catch (error) {
      this.logger.warn("Не удалось установить точку синхронизации выбранного чата", error.message);
    } finally {
      this.desktopSyncSuspended = false;
    }
    await this.telegram.sendMessage(chatId, `✅ Выбран чат:\n${threadTitle(thread)}\n${thread.cwd || ""}`);
  }

  async #newThread(chatId, name) {
    const result = await this.codex.startThread({ cwd: this.config.defaultCwd, name: name || null });
    const thread = result.thread;
    this.desktopSyncSuspended = true;
    this.state = this.stateStore.save({
      currentThreadId: thread.id,
      currentThreadName: threadTitle(thread),
      lastChatId: chatId,
      desktopSyncThreadId: null,
      desktopSyncSeenTurnIds: null,
    });
    try {
      await this.#resetDesktopSyncBaseline(thread.id);
    } catch (error) {
      this.logger.warn("Не удалось установить точку синхронизации нового чата", error.message);
    } finally {
      this.desktopSyncSuspended = false;
    }
    await this.telegram.sendMessage(chatId, `✅ Создан и выбран новый чат:\n${threadTitle(thread)}`);
  }

  async #initializeDesktopSync() {
    const threadId = this.state.currentThreadId;
    if (!threadId || !this.state.lastChatId) return;
    if (
      this.state.desktopSyncThreadId === threadId &&
      Array.isArray(this.state.desktopSyncSeenTurnIds)
    ) {
      return;
    }
    await this.#resetDesktopSyncBaseline(threadId);
  }

  async #resetDesktopSyncBaseline(threadId) {
    this.desktopSyncSuspended = true;
    try {
      const result = await this.codex.listTurns(threadId, { limit: 50, itemsView: "full" });
      const seenTurnIds = (result.data || [])
        .filter((turn) => turn?.id && turn.status !== "inProgress")
        .map((turn) => turn.id);
      this.state = this.stateStore.save({
        desktopSyncThreadId: threadId,
        desktopSyncSeenTurnIds: seenTurnIds,
      });
    } finally {
      this.desktopSyncSuspended = false;
    }
  }

  #rememberTurn(turnId, fromTelegram = false) {
    const patch = {
      desktopSyncSeenTurnIds: appendBoundedUnique(
        this.state.desktopSyncSeenTurnIds,
        turnId,
      ),
    };
    if (fromTelegram) {
      patch.telegramTurnIds = appendBoundedUnique(this.state.telegramTurnIds, turnId);
    }
    this.state = this.stateStore.save(patch);
  }

  async #pollDesktopAnswers() {
    if (this.desktopSyncRunning || this.desktopSyncSuspended) return;

    const threadId = this.state.currentThreadId;
    const chatId = this.state.lastChatId;
    if (!threadId || !chatId) return;

    this.desktopSyncRunning = true;
    try {
      if (
        this.state.desktopSyncThreadId !== threadId ||
        !Array.isArray(this.state.desktopSyncSeenTurnIds)
      ) {
        await this.#resetDesktopSyncBaseline(threadId);
        return;
      }

      const result = await this.codex.listTurns(threadId, { limit: 50, itemsView: "full" });
      const seenIds = new Set(this.state.desktopSyncSeenTurnIds);
      const telegramTurnIds = new Set(this.state.telegramTurnIds || []);
      const newTurns = unseenTerminalTurns(result.data, seenIds);

      for (const turn of newTurns) {
        if (this.state.currentThreadId !== threadId || this.state.lastChatId !== chatId) return;

        const fromTelegram = telegramTurnIds.has(turn.id);
        if (!fromTelegram && isTerminalTurnStatus(turn.status)) {
          const firstCompletedAt = this.desktopTurnFirstCompletedAt.get(turn.id);
          if (!isDesktopTurnSettled(firstCompletedAt)) {
            if (!Number.isFinite(firstCompletedAt)) {
              this.desktopTurnFirstCompletedAt.set(turn.id, Date.now());
            }
            continue;
          }
        }

        const answer = fromTelegram ? "" : extractTurnAnswer(turn);
        if (shouldWaitForTurnAnswer(turn, answer, fromTelegram)) {
          continue;
        }

        if (!fromTelegram) {
          const userText = extractTurnUserText(turn);
          if (userText) {
            await this.telegram.sendLongMessage(
              chatId,
              `💻 Сообщение из выбранного чата Codex:\n\n${userText}`,
            );
          }
          if (answer) {
            await this.telegram.sendLongMessage(
              chatId,
              `🖥 Ответ из выбранного чата Codex:\n\n${answer}`,
            );
          }
        }
        this.#rememberTurn(turn.id);
        this.desktopTurnFirstCompletedAt.delete(turn.id);
      }
    } finally {
      this.desktopSyncRunning = false;
    }
  }

  async #showStatus(chatId) {
    const threadId = this.state.currentThreadId;
    const active = threadId ? this.activeByThread.get(threadId) : null;
    const approvals = [...this.pendingApprovals.values()].filter(
      (item) => !threadId || item.params.threadId === threadId,
    );
    const lines = [
      `Codex app-server: ${this.codex.isRunning ? "работает" : "остановлен"}`,
      `Текущий чат: ${this.state.currentThreadName || "не выбран"}`,
      `Задача: ${active ? "выполняется" : "нет активной"}`,
      `Ожидает подтверждения: ${approvals.length}`,
    ];
    await this.telegram.sendMessage(chatId, lines.join("\n"));
  }

  async #sendPrompt(chatId, text) {
    const threadId = this.state.currentThreadId;
    if (!threadId) {
      await this.telegram.sendMessage(chatId, "Сначала выбери чат командой /chats.");
      return;
    }
    if (this.activeByThread.has(threadId)) {
      await this.telegram.sendMessage(
        chatId,
        "В этом чате уже выполняется задача. Используй /steer текст или /stop.",
      );
      return;
    }

    await this.codex.resumeThread(threadId);
    const current = await this.codex.readThread(threadId, false);
    if (isThreadBusy(current.thread)) {
      await this.telegram.sendMessage(
        chatId,
        [
          "⏳ Этот чат сейчас занят в приложении Codex.",
          "Дождитесь завершения текущего ответа и отправьте сообщение ещё раз.",
        ].join("\n"),
      );
      return;
    }

    const progress = await this.telegram.sendMessage(chatId, "⏳ Codex начинает работу…");
    const context = {
      chatId,
      threadId,
      turnId: null,
      progressMessageId: progress.message_id,
      itemTexts: new Map(),
      completed: false,
      editTimer: null,
    };
    this.activeByThread.set(threadId, context);

    try {
      const result = await this.codex.startTurn(threadId, text);
      context.turnId = result.turn.id;
      this.#rememberTurn(context.turnId, true);
      if (!context.completed) this.activeByTurn.set(context.turnId, context);
    } catch (error) {
      this.activeByThread.delete(threadId);
      await this.telegram.editMessage(chatId, progress.message_id, `❌ ${error.message}`);
    }
  }

  async #steerTurn(chatId, text) {
    const active = this.activeByThread.get(this.state.currentThreadId);
    if (!active?.turnId) {
      await this.telegram.sendMessage(chatId, "Нет активной задачи для уточнения.");
      return;
    }
    if (!text) {
      await this.telegram.sendMessage(chatId, "Формат: /steer дополнительное указание");
      return;
    }
    await this.codex.steerTurn(active.threadId, active.turnId, text);
    await this.telegram.sendMessage(chatId, "↪️ Уточнение передано в текущую задачу.");
  }

  async #stopTurn(chatId) {
    const active = this.activeByThread.get(this.state.currentThreadId);
    if (!active?.turnId) {
      await this.telegram.sendMessage(chatId, "Нет активной задачи.");
      return;
    }
    await this.codex.interruptTurn(active.threadId, active.turnId);
    await this.telegram.sendMessage(chatId, "⏹ Остановка запрошена.");
  }

  async #resolveApproval(chatId, accepted) {
    const approval = [...this.pendingApprovals.values()].find(
      (item) => !this.state.currentThreadId || item.params.threadId === this.state.currentThreadId,
    );
    if (!approval) {
      await this.telegram.sendMessage(chatId, "Нет действий, ожидающих подтверждения.");
      return;
    }

    if (approval.kind === "permissions") {
      if (accepted && !approval.params.permissions) {
        await this.telegram.sendMessage(
          chatId,
          "Этот запрос разрешений нельзя безопасно подтвердить из MVP. Используй /deny или приложение Codex.",
        );
        return;
      }
      this.codex.respond(approval.id, {
        permissions: accepted ? approval.params.permissions : [],
        scope: "turn",
      });
    } else {
      this.codex.respond(approval.id, { decision: accepted ? "accept" : "decline" });
    }
    this.pendingApprovals.delete(approval.id);
    await this.telegram.sendMessage(chatId, accepted ? "✅ Действие разрешено." : "🚫 Действие отклонено.");
  }

  #contextFor(params) {
    return this.activeByTurn.get(params?.turnId) || this.activeByThread.get(params?.threadId);
  }

  async #onCodexNotification(message) {
    const { method, params = {} } = message;
    if (method === "item/agentMessage/delta") {
      const context = this.#contextFor(params);
      if (!context) return;
      const key = params.itemId || "agent";
      context.itemTexts.set(key, `${context.itemTexts.get(key) || ""}${params.delta || ""}`);
      this.#scheduleProgressEdit(context);
      return;
    }

    if (method === "item/completed" && isAgentMessage(params.item)) {
      const context = this.#contextFor(params);
      if (!context) return;
      const text = extractAgentText(params.item);
      if (text) context.itemTexts.set(params.item.id || params.itemId || "agent", text);
      return;
    }

    if (method === "turn/completed") {
      const context = this.#contextFor(params);
      if (context) await this.#finishTurn(context, params.turn);
      return;
    }

    if (method === "serverRequest/resolved") {
      const requestId = params.requestId;
      if (requestId !== undefined) this.pendingApprovals.delete(requestId);
    }
  }

  #collectAgentText(context) {
    return [...context.itemTexts.values()].filter(Boolean).join("\n\n").trim();
  }

  #scheduleProgressEdit(context) {
    if (context.editTimer || context.completed) return;
    context.editTimer = setTimeout(async () => {
      context.editTimer = null;
      if (context.completed) return;
      const text = this.#collectAgentText(context);
      if (!text) return;
      const tail = text.length > 3300 ? `…${text.slice(-3300)}` : text;
      try {
        await this.telegram.editMessage(
          context.chatId,
          context.progressMessageId,
          `⏳ Codex работает…\n\n${tail}`,
        );
      } catch (error) {
        this.logger.debug("Не удалось обновить потоковый ответ Telegram", error.message);
      }
    }, 1200);
  }

  async #finishTurn(context, turn) {
    if (context.completed) return;
    context.completed = true;
    if (context.editTimer) clearTimeout(context.editTimer);
    this.activeByThread.delete(context.threadId);
    if (context.turnId) this.activeByTurn.delete(context.turnId);

    const status = turn?.status || "completed";
    let text = this.#collectAgentText(context);
    if (!text) {
      const errorText = turn?.error?.message || turn?.error;
      text = status === "completed" ? "✅ Готово." : `Задача завершена со статусом: ${status}`;
      if (errorText) text += `\n${errorText}`;
    }
    if (status === "interrupted") text = `⏹ Задача остановлена.\n\n${text}`;
    if (status === "failed") text = `❌ ${text}`;

    const chunks = splitText(text);
    try {
      await this.telegram.editMessage(context.chatId, context.progressMessageId, chunks[0]);
      for (const chunk of chunks.slice(1)) await this.telegram.sendMessage(context.chatId, chunk);
    } catch (error) {
      this.logger.warn("Не удалось отредактировать сообщение; отправляется новое", error.message);
      await this.telegram.sendLongMessage(context.chatId, text);
    }
  }

  async #onServerRequest(message) {
    const { id, method, params = {} } = message;
    let kind = null;
    if (method === "item/commandExecution/requestApproval") kind = "command";
    if (method === "item/fileChange/requestApproval") kind = "file";
    if (method === "item/permissions/requestApproval") kind = "permissions";

    const chatId = this.#contextFor(params)?.chatId || this.state.lastChatId;
    if (!kind) {
      this.logger.warn("Неподдерживаемый серверный запрос Codex", method);
      this.codex.respondError(id, -32601, `Unsupported by Telegram client: ${method}`);
      if (chatId) {
        await this.telegram.sendMessage(
          chatId,
          `⚠️ Codex запросил неподдерживаемое взаимодействие: ${method}. Задача может потребовать продолжения в приложении.`,
        );
      }
      return;
    }

    this.pendingApprovals.set(id, { id, method, params, kind });
    if (!chatId) return;

    const details = [];
    if (params.reason) details.push(`Причина: ${params.reason}`);
    if (params.command) {
      const command = Array.isArray(params.command) ? params.command.join(" ") : params.command;
      details.push(`Команда: ${redact(command).slice(0, 1400)}`);
    }
    if (params.cwd) details.push(`Папка: ${params.cwd}`);
    if (params.networkApprovalContext) {
      const network = params.networkApprovalContext;
      details.push(`Сеть: ${network.protocol || ""} ${network.host || ""}:${network.port || ""}`);
    }
    await this.telegram.sendMessage(
      chatId,
      [
        kind === "file" ? "⚠️ Codex просит разрешить изменение файлов." : "⚠️ Codex просит разрешение.",
        ...details,
        "",
        "Ответь /approve или /deny.",
      ].join("\n"),
    );
  }

  async #onCodexDisconnected(error) {
    this.logger.warn("Codex app-server отключился", error.message);
    const contexts = [...this.activeByThread.values()];
    this.activeByThread.clear();
    this.activeByTurn.clear();
    this.pendingApprovals.clear();
    for (const context of contexts) {
      context.completed = true;
      if (context.editTimer) clearTimeout(context.editTimer);
      try {
        await this.telegram.editMessage(
          context.chatId,
          context.progressMessageId,
          "⚠️ Codex app-server перезапустится при следующей команде.",
        );
      } catch {}
    }
  }

  async #onTelegramReconnected(gapMs) {
    if (!this.config.notifyAfterSleep || !this.state.lastChatId) return;
    const minutes = Math.max(1, Math.round(gapMs / 60000));
    await this.telegram.sendMessage(
      this.state.lastChatId,
      `🟢 Бот снова доступен после перерыва примерно ${minutes} мин.`,
    );
  }
}

module.exports = {
  CodexTelegramBot,
  HELP_TEXT,
  extractAgentText,
  extractTurnAnswer,
  extractTurnUserText,
  isAgentMessage,
  isDesktopTurnSettled,
  isTerminalTurnStatus,
  isThreadBusy,
  isUserMessage,
  shouldWaitForTurnAnswer,
  unseenTerminalTurns,
};
