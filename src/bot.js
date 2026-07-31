const { formatThread, formatThreadList, threadTitle } = require("./format");
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

function extractTurnUserMessages(turn) {
  const turnId = String(turn?.id || "turn");
  return (Array.isArray(turn?.items) ? turn.items : [])
    .map((item, index) => {
      if (!isUserMessage(item)) return null;
      const text = extractAgentText(item).trim();
      if (!text) return null;
      return {
        id: String(item.id || `${turnId}:user:${index}`),
        text,
      };
    })
    .filter(Boolean);
}

function extractTurnUserText(turn) {
  return extractTurnUserMessages(turn)
    .map((message) => message.text)
    .join("\n\n")
    .trim();
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

function unseenSyncTurns(turns, seenIds) {
  const seen = seenIds instanceof Set ? seenIds : new Set(seenIds || []);
  return (Array.isArray(turns) ? turns : [])
    .filter(
      (turn) =>
        turn?.id &&
        !seen.has(turn.id) &&
        (turn.status === "inProgress" || isTerminalTurnStatus(turn.status)),
    )
    .sort((left, right) => {
      const leftTime = left.completedAt || left.startedAt || 0;
      const rightTime = right.completedAt || right.startedAt || 0;
      return leftTime - rightTime || String(left.id).localeCompare(String(right.id));
    });
}

function appendBoundedUnique(items, value, limit = 200) {
  return [...new Set([...(Array.isArray(items) ? items : []), value])].slice(-limit);
}

function appendPendingTelegramFinal(items, entry, limit = 200) {
  const turnId = String(entry?.turnId || "");
  if (!turnId) return Array.isArray(items) ? items : [];
  const pending = (Array.isArray(items) ? items : []).filter(
    (item) => String(item?.turnId || "") !== turnId,
  );
  pending.push({
    turnId,
    threadId: String(entry.threadId || ""),
    chatId: entry.chatId,
  });
  return pending.slice(-limit);
}

function formatTelegramTurnResult(turn, text) {
  const status = turn?.status || "completed";
  let result = String(text || "").trim();
  const errorText = turn?.error?.message || turn?.error;

  if (!result && status !== "completed") {
    result = `Задача завершена со статусом: ${status}`;
    if (errorText) result += `\n${errorText}`;
  }
  if (!result) return "";
  if (status === "interrupted") return `⏹ Задача остановлена.\n\n${result}`;
  if (status === "failed") return `❌ ${result}`;
  return result;
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
    this.telegramFinalDeliveryPromises = new Map();

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
    this.#initializeTelegramFinalDeliveryTracking();
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

  #initializeTelegramFinalDeliveryTracking() {
    const delivered = this.state.telegramFinalDeliveredTurnIds;
    const pending = this.state.telegramPendingFinals;
    if (Array.isArray(delivered) && Array.isArray(pending)) return;

    this.state = this.stateStore.save({
      // При первом обновлении старые Telegram-turn считаются доставленными,
      // чтобы не переслать владельцу всю прежнюю историю.
      telegramFinalDeliveredTurnIds: Array.isArray(delivered)
        ? delivered
        : [...new Set(this.state.telegramTurnIds || [])].slice(-500),
      telegramPendingFinals: Array.isArray(pending) ? pending : [],
    });
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
      desktopSyncSentUserMessageIds: null,
      desktopSyncSentUserTurnIds: null,
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
      desktopSyncSentUserMessageIds: null,
      desktopSyncSentUserTurnIds: null,
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
        .filter((turn) => turn?.id && isTerminalTurnStatus(turn.status))
        .map((turn) => turn.id);
      const sentUserMessageIds = (result.data || []).flatMap((turn) =>
        extractTurnUserMessages(turn).map((message) => message.id),
      );
      this.state = this.stateStore.save({
        desktopSyncThreadId: threadId,
        desktopSyncSeenTurnIds: seenTurnIds,
        desktopSyncSentUserMessageIds: sentUserMessageIds,
        desktopSyncSentUserTurnIds: [],
      });
      this.desktopTurnFirstCompletedAt.clear();
    } finally {
      this.desktopSyncSuspended = false;
    }
  }

  #rememberTurn(turnId, fromTelegram = false, delivery = null) {
    const patch = {
      desktopSyncSeenTurnIds: appendBoundedUnique(
        this.state.desktopSyncSeenTurnIds,
        turnId,
      ),
    };
    if (fromTelegram) {
      patch.telegramTurnIds = appendBoundedUnique(this.state.telegramTurnIds, turnId);
      const alreadyDelivered = (this.state.telegramFinalDeliveredTurnIds || []).includes(turnId);
      patch.telegramPendingFinals = alreadyDelivered
        ? this.state.telegramPendingFinals
        : appendPendingTelegramFinal(this.state.telegramPendingFinals, {
            turnId,
            threadId: delivery?.threadId,
            chatId: delivery?.chatId,
          });
    }
    this.state = this.stateStore.save(patch);
  }

  async #sendTelegramFinalOnce(turnId, chatId, text) {
    if (!turnId) {
      await this.telegram.sendLongMessage(chatId, text);
      return true;
    }
    if ((this.state.telegramFinalDeliveredTurnIds || []).includes(turnId)) return false;

    const existing = this.telegramFinalDeliveryPromises.get(turnId);
    if (existing) return existing;

    const delivery = (async () => {
      await this.telegram.sendLongMessage(chatId, text);
      this.state = this.stateStore.save({
        telegramFinalDeliveredTurnIds: appendBoundedUnique(
          this.state.telegramFinalDeliveredTurnIds,
          turnId,
          500,
        ),
        telegramPendingFinals: (this.state.telegramPendingFinals || []).filter(
          (item) => item?.turnId !== turnId,
        ),
      });
      this.logger.info("Финальный ответ Telegram доставлен", { turnId });
      return true;
    })();
    this.telegramFinalDeliveryPromises.set(turnId, delivery);
    try {
      return await delivery;
    } finally {
      this.telegramFinalDeliveryPromises.delete(turnId);
    }
  }

  async #retryPendingTelegramFinals() {
    const delivered = new Set(this.state.telegramFinalDeliveredTurnIds || []);
    const pending = (this.state.telegramPendingFinals || []).filter(
      (item) => item?.turnId && item?.threadId && item?.chatId && !delivered.has(item.turnId),
    );
    if (!pending.length) return;

    const byThread = new Map();
    for (const item of pending) {
      if (!byThread.has(item.threadId)) byThread.set(item.threadId, []);
      byThread.get(item.threadId).push(item);
    }

    for (const [threadId, entries] of byThread) {
      try {
        const result = await this.codex.listTurns(threadId, { limit: 50, itemsView: "full" });
        const turns = new Map((result.data || []).map((turn) => [turn.id, turn]));
        for (const entry of entries) {
          const turn = turns.get(entry.turnId);
          if (!turn || !isTerminalTurnStatus(turn.status)) continue;
          const text = formatTelegramTurnResult(turn, extractTurnAnswer(turn));
          if (!text) continue;
          await this.#sendTelegramFinalOnce(entry.turnId, entry.chatId, text);
        }
      } catch (error) {
        this.logger.warn("Не удалось повторить доставку финального ответа Telegram", {
          threadId,
          message: error.message,
        });
      }
    }
  }

  async #pollDesktopAnswers() {
    if (this.desktopSyncRunning || this.desktopSyncSuspended) return;

    this.desktopSyncRunning = true;
    try {
      await this.#retryPendingTelegramFinals();

      const threadId = this.state.currentThreadId;
      const chatId = this.state.lastChatId;
      if (!threadId || !chatId) return;

      if (
        this.state.desktopSyncThreadId !== threadId ||
        !Array.isArray(this.state.desktopSyncSeenTurnIds)
      ) {
        await this.#resetDesktopSyncBaseline(threadId);
        return;
      }

      const result = await this.codex.listTurns(threadId, { limit: 50, itemsView: "full" });
      const seenIds = new Set(this.state.desktopSyncSeenTurnIds);
      const sentUserMessageIds = new Set(this.state.desktopSyncSentUserMessageIds || []);
      const legacySentUserTurnIds = new Set(this.state.desktopSyncSentUserTurnIds || []);
      const telegramTurnIds = new Set(this.state.telegramTurnIds || []);
      const newTurns = unseenSyncTurns(result.data, seenIds);

      for (const turn of newTurns) {
        if (this.state.currentThreadId !== threadId || this.state.lastChatId !== chatId) return;

        const fromTelegram = telegramTurnIds.has(turn.id);
        if (!fromTelegram) {
          const userMessages = extractTurnUserMessages(turn);
          if (legacySentUserTurnIds.has(turn.id) && userMessages.length) {
            const migratedIds = userMessages
              .map((message) => message.id)
              .filter((messageId) => !sentUserMessageIds.has(messageId));
            for (const messageId of migratedIds) sentUserMessageIds.add(messageId);
            legacySentUserTurnIds.delete(turn.id);
            this.state = this.stateStore.save({
              desktopSyncSentUserMessageIds: migratedIds.reduce(
                (ids, messageId) => appendBoundedUnique(ids, messageId, 500),
                this.state.desktopSyncSentUserMessageIds,
              ),
              desktopSyncSentUserTurnIds: [...legacySentUserTurnIds],
            });
          } else {
            for (const message of userMessages) {
              if (sentUserMessageIds.has(message.id)) continue;
              await this.telegram.sendLongMessage(
                chatId,
                `💻 Сообщение из выбранного чата Codex:\n\n${message.text}`,
              );
              sentUserMessageIds.add(message.id);
              this.state = this.stateStore.save({
                desktopSyncSentUserMessageIds: appendBoundedUnique(
                  this.state.desktopSyncSentUserMessageIds,
                  message.id,
                  500,
                ),
              });
            }
          }
        }

        if (!isTerminalTurnStatus(turn.status)) continue;

        if (!fromTelegram) {
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
      this.#rememberTurn(context.turnId, true, { threadId, chatId });
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
    const turnId = params?.turnId || params?.turn?.id;
    const threadId = params?.threadId || params?.turn?.threadId;
    return this.activeByTurn.get(turnId) || this.activeByThread.get(threadId);
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
      if (context) {
        if (!context.turnId) context.turnId = params.turnId || params.turn?.id || null;
        await this.#finishTurn(context, params.turn);
      }
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

    const turnId = context.turnId || turn?.id;
    const text = formatTelegramTurnResult(turn, this.#collectAgentText(context)) || "✅ Готово.";
    try {
      await this.#sendTelegramFinalOnce(turnId, context.chatId, text);
      try {
        await this.telegram.editMessage(
          context.chatId,
          context.progressMessageId,
          "✅ Codex завершил работу. Ответ отправлен следующим сообщением.",
        );
      } catch (error) {
        this.logger.debug("Не удалось обновить сообщение о ходе задачи", error.message);
      }
    } catch (error) {
      this.logger.warn("Финальный ответ Telegram не доставлен; будет повторная попытка", {
        turnId,
        message: error.message,
      });
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
  extractTurnUserMessages,
  extractTurnUserText,
  appendPendingTelegramFinal,
  formatTelegramTurnResult,
  isAgentMessage,
  isDesktopTurnSettled,
  isTerminalTurnStatus,
  isThreadBusy,
  isUserMessage,
  shouldWaitForTurnAnswer,
  unseenSyncTurns,
  unseenTerminalTurns,
};
