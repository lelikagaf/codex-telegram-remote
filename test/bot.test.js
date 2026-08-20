const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  CodexTelegramBot,
  appendPendingTelegramFinal,
  buildDocumentPrompt,
  collectOutgoingTelegramFiles,
  extractAgentText,
  extractTurnAnswer,
  extractTurnUserMessages,
  extractTurnUserText,
  formatModelList,
  formatModelSettings,
  formatTelegramTurnResult,
  hasActiveTurn,
  isAgentMessage,
  isActiveTurnStatus,
  isDesktopTurnSettled,
  isTerminalTurnStatus,
  isThreadBusy,
  isUnmaterializedThreadError,
  isUserMessage,
  modelByName,
  nextTelegramUploadPath,
  resolveTelegramUploadCwd,
  sanitizeTelegramFileName,
  shouldWaitForTurnAnswer,
  unseenSyncTurns,
  unseenTerminalTurns,
} = require("../src/bot");

function createStateStore(overrides = {}) {
  return {
    state: {
      currentThreadId: "thread-1",
      currentThreadName: "Тест",
      lastChatId: 100,
      lastListedThreadIds: [],
      lastUpdateOffset: 0,
      desktopSyncThreadId: "thread-1",
      desktopSyncSeenTurnIds: [],
      desktopSyncSentUserMessageIds: [],
      desktopSyncSentUserTurnIds: [],
      telegramTurnIds: [],
      telegramPendingFinals: [],
      telegramFinalDeliveredTurnIds: [],
      ...overrides,
    },
    save(patch) {
      this.state = { ...this.state, ...patch };
      return this.state;
    },
  };
}

function createLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Истекло время ожидания условия");
}

test("извлекается текст agentMessage", () => {
  assert.equal(extractAgentText({ type: "agentMessage", text: "Готово" }), "Готово");
  assert.equal(isAgentMessage({ type: "agentMessage" }), true);
});

test("извлекается текст из content", () => {
  assert.equal(
    extractAgentText({ content: [{ type: "output_text", text: "Раз" }, { text: "Два" }] }),
    "Раз\nДва",
  );
});

test("имя Telegram-документа очищается от пути и недопустимых символов", () => {
  assert.equal(sanitizeTelegramFileName("../../bad:name?.md"), "bad_name_.md");
  assert.equal(sanitizeTelegramFileName("CON.txt"), "_CON.txt");
  assert.equal(sanitizeTelegramFileName("..."), "document");
  assert.match(
    nextTelegramUploadPath("C:\\Project", "file.md", 10),
    /\.codex-telegram-uploads[\\/]10-file\.md$/,
  );
});

test("загрузка Telegram-документа не использует системный cwd старого чата", () => {
  const fallback = "C:\\Users\\lelik\\Documents\\Codex";
  assert.equal(resolveTelegramUploadCwd("C:\\WINDOWS\\system32", fallback), fallback);
  assert.equal(
    resolveTelegramUploadCwd("C:\\Users\\lelik\\Documents\\Codex\\Bridge8", fallback),
    "C:\\Users\\lelik\\Documents\\Codex\\Bridge8",
  );
});

test("prompt документа содержит локальный путь и подпись пользователя", () => {
  const prompt = buildDocumentPrompt({
    localPath: "C:\\Project\\.codex-telegram-uploads\\10-file.md",
    fileName: "file.md",
    mimeType: "text/markdown",
    size: 42,
    caption: "Положи в docs и прочитай.",
  });
  assert.match(prompt, /10-file\.md/);
  assert.match(prompt, /Положи в docs и прочитай/);
  assert.match(prompt, /42 байт/);
});

test("активный чат считается занятым", () => {
  assert.equal(isThreadBusy({ status: { type: "active", activeFlags: [] } }), true);
});

test("idle-чат считается свободным", () => {
  assert.equal(isThreadBusy({ status: { type: "idle" }, turns: [] }), false);
});

test("незавершённый turn считается занятым даже без статуса active", () => {
  assert.equal(
    isThreadBusy({
      status: { type: "notLoaded" },
      turns: [{ id: "turn-1", status: "inProgress" }],
    }),
    true,
  );
});

test("проверка занятости распознаёт статусы активного Desktop-turn", () => {
  for (const status of ["inProgress", "in_progress", "active", "running"]) {
    assert.equal(isActiveTurnStatus(status), true);
    assert.equal(hasActiveTurn([{ id: "desktop-turn", status }]), true);
  }
  for (const status of ["completed", "interrupted", "failed", undefined, "newStatus"]) {
    assert.equal(isActiveTurnStatus(status), false);
    assert.equal(hasActiveTurn([{ id: "desktop-turn", status }]), false);
  }
});

test("из turn извлекается только финальный ответ", () => {
  assert.equal(
    extractTurnAnswer({
      items: [
        { type: "agentMessage", phase: "commentary", text: "Проверяю…" },
        { type: "agentMessage", phase: "final_answer", text: "Готово." },
      ],
    }),
    "Готово.",
  );
});

test("из Desktop-turn извлекается сообщение пользователя", () => {
  const turn = {
    id: "turn-1",
    items: [
      { id: "item-1", type: "userMessage", content: [{ type: "text", text: "Проверка" }] },
      { type: "userMessage", content: [{ type: "text", text: "Уточнение" }] },
      { type: "agentMessage", phase: "final_answer", text: "Готово." },
    ],
  };
  assert.equal(isUserMessage(turn.items[0]), true);
  assert.deepEqual(extractTurnUserMessages(turn), [
    { id: "item-1", text: "Проверка" },
    { id: "turn-1:user:1", text: "Уточнение" },
  ]);
  assert.equal(extractTurnUserText(turn), "Проверка\n\nУточнение");
});

test("unseenSyncTurns включает активный Desktop-turn для немедленной пересылки сообщения", () => {
  const turns = unseenSyncTurns(
    [
      { id: "active", status: "inProgress", startedAt: 20 },
      { id: "done", status: "completed", completedAt: 30 },
      { id: "seen", status: "completed", completedAt: 10 },
      { id: "unknown", status: "newStatus", startedAt: 40 },
    ],
    new Set(["seen"]),
  );
  assert.deepEqual(
    turns.map((turn) => turn.id),
    ["active", "done"],
  );
});

test("unseenTerminalTurns исключает активные и уже виденные turns", () => {
  const turns = unseenTerminalTurns(
    [
      { id: "done-2", status: "completed", completedAt: 20 },
      { id: "active", status: "inProgress", startedAt: 30 },
      { id: "active-snake", status: "in_progress", startedAt: 31 },
      { id: "active-unknown", status: "active", startedAt: 32 },
      { id: "unknown", status: "newStatus", startedAt: 33 },
      { id: "seen", status: "completed", completedAt: 10 },
      { id: "done-1", status: "completed", completedAt: 15 },
      { id: "failed", status: "failed", completedAt: 25 },
      { id: "interrupted", status: "interrupted", completedAt: 30 },
    ],
    new Set(["seen"]),
  );
  assert.deepEqual(
    turns.map((turn) => turn.id),
    ["done-1", "done-2", "failed", "interrupted"],
  );
});

test("конечными считаются только известные завершённые статусы", () => {
  for (const status of ["completed", "interrupted", "failed"]) {
    assert.equal(isTerminalTurnStatus(status), true);
  }
  for (const status of ["inProgress", "in_progress", "active", undefined, "newStatus"]) {
    assert.equal(isTerminalTurnStatus(status), false);
  }
});

test("любой конечный Desktop-turn без ответа остаётся для повторного опроса", () => {
  for (const status of ["completed", "failed", "interrupted"]) {
    const turn = { id: "desktop-turn", status };
    assert.equal(shouldWaitForTurnAnswer(turn, "", false), true);
    assert.equal(shouldWaitForTurnAnswer(turn, "Готово.", false), false);
    assert.equal(shouldWaitForTurnAnswer(turn, "", true), false);
  }
});

test("Desktop-turn обрабатывается только после периода стабилизации", () => {
  const firstCompletedAt = 1000;
  assert.equal(isDesktopTurnSettled(undefined, 10000), false);
  assert.equal(isDesktopTurnSettled(firstCompletedAt, 6999), false);
  assert.equal(isDesktopTurnSettled(firstCompletedAt, 7000), true);
});

test("очередь финалов Telegram обновляет существующую запись turn", () => {
  assert.deepEqual(
    appendPendingTelegramFinal(
      [{ turnId: "turn-1", threadId: "old", chatId: 1 }],
      { turnId: "turn-1", threadId: "thread-1", chatId: 100 },
    ),
    [{ turnId: "turn-1", threadId: "thread-1", chatId: 100 }],
  );
});

test("результат Telegram-turn сохраняет статус ошибки", () => {
  assert.equal(formatTelegramTurnResult({ status: "completed" }, "Готово"), "Готово");
  assert.equal(
    formatTelegramTurnResult({ status: "failed", error: { message: "Сбой" } }, ""),
    "❌ Задача завершена со статусом: failed\nСбой",
  );
});

const modelCatalog = [
  {
    id: "gpt-5.6-sol",
    model: "gpt-5.6-sol",
    displayName: "GPT-5.6-Sol",
    isDefault: true,
    hidden: false,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast responses" },
      { reasoningEffort: "high", description: "Deep reasoning" },
      { reasoningEffort: "ultra", description: "Automatic delegation" },
    ],
  },
  {
    id: "gpt-5.6-terra",
    model: "gpt-5.6-terra",
    displayName: "GPT-5.6-Terra",
    isDefault: false,
    hidden: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast responses" },
      { reasoningEffort: "medium", description: "Balanced" },
      { reasoningEffort: "high", description: "Deep reasoning" },
    ],
  },
];

test("формат модели показывает текущие и доступные усилия", () => {
  assert.equal(modelByName(modelCatalog, "GPT-5.6-SOL"), modelCatalog[0]);
  assert.match(
    formatModelSettings(
      { model: "gpt-5.6-sol", reasoningEffort: "ultra" },
      modelCatalog,
    ),
    /ultra — максимальная глубина с автоматическим делегированием/,
  );
  assert.match(formatModelList(modelCatalog), /gpt-5\.6-terra/);
});

test("команда /model меняет усилие выбранного чата", async () => {
  const sent = [];
  const telegram = new EventEmitter();
  telegram.sendMessage = async (chatId, text) => sent.push({ chatId, text });
  telegram.sendLongMessage = async (chatId, text) => sent.push({ chatId, text });

  const updates = [];
  const codex = new EventEmitter();
  codex.getThreadModelSettings = async () => ({
    model: "gpt-5.6-sol",
    reasoningEffort: "low",
  });
  codex.listModels = async () => ({ data: modelCatalog });
  codex.updateThreadModelSettings = async (threadId, settings) => {
    updates.push({ threadId, settings });
    return { model: "gpt-5.6-sol", reasoningEffort: settings.reasoningEffort };
  };

  const bot = new CodexTelegramBot({
    telegram,
    codex,
    stateStore: createStateStore(),
    config: { allowedUserId: 7, desktopSyncPollMs: 1000 },
    logger: createLogger(),
  });

  await bot.handleUpdate({
    message: { from: { id: 7 }, chat: { id: 100 }, text: "/model high" },
  });

  assert.deepEqual(updates, [
    { threadId: "thread-1", settings: { reasoningEffort: "high" } },
  ]);
  assert.match(sent.at(-1).text, /Настройки обновлены/);
  assert.match(sent.at(-1).text, /Усилие: high/);
});

test("команда /model добавлена в меню быстрых команд", async () => {
  let commands = [];
  const telegram = new EventEmitter();
  telegram.deleteWebhook = async () => {};
  telegram.setMyCommands = async (items) => {
    commands = items;
  };

  const codex = new EventEmitter();
  codex.ensureStarted = async () => {};

  const bot = new CodexTelegramBot({
    telegram,
    codex,
    stateStore: createStateStore({ currentThreadId: null, lastChatId: null }),
    config: { allowedUserId: 7, desktopSyncPollMs: 1000 },
    logger: createLogger(),
  });

  await bot.initialize();
  bot.stop();

  assert.equal(commands.some((item) => item.command === "model"), true);
});

test("финал Telegram-turn отправляется новым сообщением и подтверждается в состоянии", async () => {
  const sent = [];
  const edits = [];
  const telegram = new EventEmitter();
  telegram.sendMessage = async (chatId, text) => {
    sent.push({ kind: "message", chatId, text });
    return { message_id: 10 };
  };
  telegram.sendLongMessage = async (chatId, text) => {
    sent.push({ kind: "final", chatId, text });
    return [{ message_id: 11 }];
  };
  telegram.editMessage = async (chatId, messageId, text) => {
    edits.push({ chatId, messageId, text });
  };

  const codex = new EventEmitter();
  codex.resumeThread = async () => {};
  codex.readThread = async () => ({ thread: { status: { type: "idle" }, turns: [] } });
  codex.listTurns = async () => ({ data: [] });
  codex.startTurn = async () => ({ turn: { id: "turn-1" } });

  const stateStore = createStateStore();
  const bot = new CodexTelegramBot({
    telegram,
    codex,
    stateStore,
    config: { allowedUserId: 7, desktopSyncPollMs: 1000, incomingMessageSettleMs: 1 },
    logger: createLogger(),
  });

  await bot.handleUpdate({
    message: { from: { id: 7 }, chat: { id: 100 }, text: "Сделай" },
  });
  await waitFor(() => sent.some((item) => item.text === "⏳ Codex начинает работу…"));
  codex.emit("notification", {
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "answer-1", type: "agentMessage", phase: "final_answer", text: "Готово" },
    },
  });
  codex.emit("notification", {
    method: "turn/completed",
    params: { turn: { id: "turn-1", threadId: "thread-1", status: "completed" } },
  });

  await waitFor(() => stateStore.state.telegramFinalDeliveredTurnIds.includes("turn-1"));
  assert.deepEqual(
    sent.map((item) => [item.kind, item.text]),
    [
      ["message", "✉️ Сообщение поставлено в очередь обработки: 1."],
      ["message", "⏳ Codex начинает работу…"],
      ["final", "Готово"],
    ],
  );
  assert.equal(edits.at(-1).text, "✅ Codex завершил работу. Ответ отправлен следующим сообщением.");
  assert.deepEqual(stateStore.state.telegramPendingFinals, []);
});

test("Telegram не запускает новый turn, пока Desktop-turn активен", async () => {
  const sent = [];
  const telegram = new EventEmitter();
  telegram.sendMessage = async (chatId, text) => {
    sent.push({ chatId, text });
    return { message_id: 10 };
  };

  let startTurnCalls = 0;
  const codex = new EventEmitter();
  codex.resumeThread = async () => {};
  codex.readThread = async () => ({ thread: { status: { type: "idle" }, turns: [] } });
  codex.listTurns = async () => ({
    data: [{ id: "desktop-turn", status: "inProgress" }],
  });
  codex.startTurn = async () => {
    startTurnCalls += 1;
    return { turn: { id: "telegram-turn" } };
  };

  const bot = new CodexTelegramBot({
    telegram,
    codex,
    stateStore: createStateStore(),
    config: { allowedUserId: 7, desktopSyncPollMs: 1000, incomingMessageSettleMs: 1 },
    logger: createLogger(),
  });

  await bot.handleUpdate({
    message: { from: { id: 7 }, chat: { id: 100 }, text: "Не запускать параллельно" },
  });

  await waitFor(() => sent.length > 0);
  assert.equal(startTurnCalls, 0);
  assert.match(sent.at(-1).text, /очередь/);
});

test("очередь Telegram запускается после завершения активного Desktop-turn", async () => {
  const sent = [];
  const telegram = new EventEmitter();
  telegram.deleteWebhook = async () => {};
  telegram.setMyCommands = async () => {};
  telegram.sendMessage = async (chatId, text) => {
    sent.push({ chatId, text });
    return { message_id: sent.length };
  };

  let desktopBusy = true;
  const prompts = [];
  const codex = new EventEmitter();
  codex.ensureStarted = async () => {};
  codex.resumeThread = async () => {};
  codex.readThread = async () => ({ thread: { status: { type: "idle" }, turns: [] } });
  codex.listTurns = async () => ({
    data: desktopBusy ? [{ id: "desktop-turn", status: "inProgress" }] : [],
  });
  codex.startTurn = async (_threadId, text) => {
    prompts.push(text);
    return { turn: { id: "telegram-turn" } };
  };

  const bot = new CodexTelegramBot({
    telegram,
    codex,
    stateStore: createStateStore({
      desktopSyncThreadId: "thread-1",
      desktopSyncSeenTurnIds: [],
    }),
    config: { allowedUserId: 7, desktopSyncPollMs: 5, incomingMessageSettleMs: 1 },
    logger: createLogger(),
  });

  await bot.initialize();
  await bot.handleUpdate({
    message: { from: { id: 7 }, chat: { id: 100 }, text: "Запусти после Desktop" },
  });

  await waitFor(() => sent.some((item) => /очередь/.test(item.text)));
  assert.equal(prompts.length, 0);

  desktopBusy = false;
  await waitFor(() => prompts.length === 1);
  bot.stop();

  assert.equal(prompts[0], "Запусти после Desktop");
});

test("первое сообщение запускается в ещё не материализованном чате", async () => {
  const sent = [];
  const telegram = new EventEmitter();
  telegram.sendMessage = async (chatId, text) => {
    sent.push({ chatId, text });
    return { message_id: 10 };
  };
  telegram.editMessage = async () => {};

  let startTurnCalls = 0;
  const codex = new EventEmitter();
  codex.resumeThread = async () => {};
  codex.readThread = async () => ({ thread: { status: { type: "idle" }, turns: [] } });
  codex.listTurns = async () => {
    throw new Error(
      "thread/turns/list: thread thread-1 is not materialized yet; thread/turns/list is unavailable before first user message",
    );
  };
  codex.startTurn = async () => {
    startTurnCalls += 1;
    return { turn: { id: "telegram-turn" } };
  };

  const bot = new CodexTelegramBot({
    telegram,
    codex,
    stateStore: createStateStore(),
    config: { allowedUserId: 7, desktopSyncPollMs: 1000, incomingMessageSettleMs: 1 },
    logger: createLogger(),
  });

  await bot.handleUpdate({
    message: { from: { id: 7 }, chat: { id: 100 }, text: "Первое сообщение" },
  });

  await waitFor(() => startTurnCalls === 1);
  assert.equal(sent.at(-1).text, "⏳ Codex начинает работу…");
});

test("несколько Telegram-сообщений склеиваются в одну входящую посылку", async () => {
  const telegram = new EventEmitter();
  telegram.sendMessage = async () => ({ message_id: 10 });
  telegram.editMessage = async () => {};

  const prompts = [];
  const codex = new EventEmitter();
  codex.resumeThread = async () => {};
  codex.readThread = async () => ({ thread: { status: { type: "idle" }, turns: [] } });
  codex.listTurns = async () => ({ data: [] });
  codex.startTurn = async (_threadId, text) => {
    prompts.push(text);
    return { turn: { id: "telegram-turn" } };
  };

  const bot = new CodexTelegramBot({
    telegram,
    codex,
    stateStore: createStateStore(),
    config: { allowedUserId: 7, desktopSyncPollMs: 1000, incomingMessageSettleMs: 5 },
    logger: createLogger(),
  });

  await bot.handleUpdate({
    message: { from: { id: 7 }, chat: { id: 100 }, text: "Первая часть" },
  });
  await bot.handleUpdate({
    message: { from: { id: 7 }, chat: { id: 100 }, text: "Вторая часть" },
  });

  await waitFor(() => prompts.length === 1);

  assert.equal(prompts[0], "Первая часть\n\nВторая часть");
});

test("распознаётся ошибка ещё не материализованного чата", () => {
  assert.equal(
    isUnmaterializedThreadError(
      new Error("thread/turns/list is unavailable before first user message"),
    ),
    true,
  );
  assert.equal(isUnmaterializedThreadError(new Error("other failure")), false);
});

test("Telegram-документ скачивается без лимита и передаётся Codex вместе с подписью", async () => {
  const sent = [];
  const edits = [];
  const downloads = [];
  const telegram = new EventEmitter();
  telegram.sendMessage = async (chatId, text) => {
    sent.push({ chatId, text });
    return { message_id: sent.length };
  };
  telegram.editMessage = async (chatId, messageId, text) => {
    edits.push({ chatId, messageId, text });
  };
  telegram.downloadFile = async (fileId, destinationPath, options) => {
    downloads.push({ fileId, destinationPath, options });
    return { path: destinationPath, size: 8600 };
  };

  let prompt = null;
  const codex = new EventEmitter();
  codex.resumeThread = async () => {};
  codex.readThread = async () => ({
    thread: { cwd: "C:\\Project", status: { type: "idle" }, turns: [] },
  });
  codex.listTurns = async () => ({ data: [] });
  codex.startTurn = async (_threadId, text) => {
    prompt = text;
    return { turn: { id: "document-turn" } };
  };

  const bot = new CodexTelegramBot({
    telegram,
    codex,
    stateStore: createStateStore(),
    config: {
      allowedUserId: 7,
      defaultCwd: "C:\\Project",
      desktopSyncPollMs: 1000,
      telegramMaxFileBytes: 0,
      incomingMessageSettleMs: 1,
    },
    logger: createLogger(),
  });

  await bot.handleUpdate({
    message: {
      message_id: 55,
      from: { id: 7 },
      chat: { id: 100 },
      caption: "Положи документ в docs и ознакомься с ним.",
      document: {
        file_id: "telegram-file-id",
        file_name: "Bridge8:Vision?.md",
        file_size: 8600,
        mime_type: "text/markdown",
      },
    },
  });
  await waitFor(() => downloads.length === 1);

  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].options.maxBytes, 0);
  assert.match(downloads[0].destinationPath, /\.codex-telegram-uploads[\\/]55-Bridge8_Vision_\.md$/);
  assert.match(prompt, /Положи документ в docs/);
  assert.match(prompt, /55-Bridge8_Vision_\.md/);
  assert.match(edits[0].text, /без ограничения/);
  assert.equal(sent.at(-1).text, "⏳ Codex начинает работу…");
});

test("Telegram-документ больше настроенного лимита отклоняется до скачивания", async () => {
  const sent = [];
  let downloadCalls = 0;
  const telegram = new EventEmitter();
  telegram.sendMessage = async (chatId, text) => {
    sent.push({ chatId, text });
    return { message_id: 1 };
  };
  telegram.downloadFile = async () => {
    downloadCalls += 1;
  };

  const bot = new CodexTelegramBot({
    telegram,
    codex: new EventEmitter(),
    stateStore: createStateStore(),
    config: {
      allowedUserId: 7,
      desktopSyncPollMs: 1000,
      telegramMaxFileBytes: 1024,
      incomingMessageSettleMs: 1,
    },
    logger: createLogger(),
  });

  await bot.handleUpdate({
    message: {
      message_id: 56,
      from: { id: 7 },
      chat: { id: 100 },
      document: { file_id: "large-file", file_name: "large.bin", file_size: 1025 },
    },
  });
  await waitFor(() => sent.length > 0);

  assert.equal(downloadCalls, 0);
  assert.match(sent.at(-1).text, /больше разрешённого лимита/);
});

test("пропущенный финал Telegram повторно доставляется фоновым опросом", async () => {
  const sent = [];
  const telegram = new EventEmitter();
  telegram.deleteWebhook = async () => {};
  telegram.setMyCommands = async () => {};
  telegram.sendLongMessage = async (chatId, text) => {
    sent.push({ chatId, text });
    return [{ message_id: 20 }];
  };

  const codex = new EventEmitter();
  codex.ensureStarted = async () => {};
  codex.listTurns = async () => ({
    data: [
      {
        id: "turn-lost",
        status: "completed",
        items: [{ type: "agentMessage", phase: "final_answer", text: "Восстановлено" }],
      },
    ],
  });

  const stateStore = createStateStore({
    desktopSyncSeenTurnIds: ["turn-lost"],
    telegramTurnIds: ["turn-lost"],
    telegramPendingFinals: [{ turnId: "turn-lost", threadId: "thread-1", chatId: 100 }],
  });
  const bot = new CodexTelegramBot({
    telegram,
    codex,
    stateStore,
    config: { allowedUserId: 7, desktopSyncPollMs: 5 },
    logger: createLogger(),
  });

  await bot.initialize();
  await waitFor(() => stateStore.state.telegramFinalDeliveredTurnIds.includes("turn-lost"));
  bot.stop();

  assert.deepEqual(sent, [{ chatId: 100, text: "Восстановлено" }]);
  assert.deepEqual(stateStore.state.telegramPendingFinals, []);
});

test("обновление не пересылает заново старые Telegram-turn", async () => {
  const sent = [];
  const telegram = new EventEmitter();
  telegram.deleteWebhook = async () => {};
  telegram.setMyCommands = async () => {};
  telegram.sendLongMessage = async (chatId, text) => sent.push({ chatId, text });

  const codex = new EventEmitter();
  codex.ensureStarted = async () => {};
  codex.listTurns = async () => ({ data: [] });

  const stateStore = createStateStore({
    currentThreadId: null,
    desktopSyncThreadId: null,
    desktopSyncSeenTurnIds: null,
    telegramTurnIds: ["old-turn"],
    telegramFinalDeliveredTurnIds: null,
  });
  const bot = new CodexTelegramBot({
    telegram,
    codex,
    stateStore,
    config: { allowedUserId: 7, desktopSyncPollMs: 5 },
    logger: createLogger(),
  });

  await bot.initialize();
  await new Promise((resolve) => setTimeout(resolve, 15));
  bot.stop();

  assert.deepEqual(stateStore.state.telegramFinalDeliveredTurnIds, ["old-turn"]);
  assert.deepEqual(sent, []);
});

test("Telegram documents from one media group are sent to Codex as one turn", async () => {
  const sent = [];
  const downloads = [];
  const telegram = new EventEmitter();
  telegram.sendMessage = async (chatId, text) => {
    sent.push({ chatId, text });
    return { message_id: sent.length };
  };
  telegram.editMessage = async () => {};
  telegram.downloadFile = async (fileId, destinationPath, options) => {
    downloads.push({ fileId, destinationPath, options });
    return { path: destinationPath, size: fileId === "file-a" ? 100 : 200 };
  };

  const prompts = [];
  const codex = new EventEmitter();
  codex.resumeThread = async () => {};
  codex.readThread = async () => ({
    thread: { cwd: "C:\\Project", status: { type: "idle" }, turns: [] },
  });
  codex.listTurns = async () => ({ data: [] });
  codex.startTurn = async (_threadId, text) => {
    prompts.push(text);
    return { turn: { id: `document-turn-${prompts.length}` } };
  };

  const bot = new CodexTelegramBot({
    telegram,
    codex,
    stateStore: createStateStore(),
    config: {
      allowedUserId: 7,
      defaultCwd: "C:\\Project",
      desktopSyncPollMs: 1000,
      telegramMaxFileBytes: 0,
      incomingMessageSettleMs: 1,
    },
    logger: createLogger(),
  });

  await bot.handleUpdate({
    message: {
      message_id: 61,
      media_group_id: "album-1",
      from: { id: 7 },
      chat: { id: 100 },
      caption: "Use both files.",
      document: { file_id: "file-a", file_name: "a.md", file_size: 100 },
    },
  });
  await bot.handleUpdate({
    message: {
      message_id: 62,
      media_group_id: "album-1",
      from: { id: 7 },
      chat: { id: 100 },
      document: { file_id: "file-b", file_name: "b.md", file_size: 200 },
    },
  });

  await waitFor(() => prompts.length === 1);

  assert.equal(downloads.length, 2);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /61-a\.md/);
  assert.match(prompts[0], /62-b\.md/);
  assert.match(prompts[0], /Use both files/);
  assert.match(prompts[0], /Process every listed document/);
  assert.match(prompts[0], /Do not use PowerShell Get-Content\/Set-Content/);
  assert.match(sent.at(-1).text, /Codex/);
});

test("Telegram document and following text are processed as one incoming batch", async () => {
  const downloads = [];
  const telegram = new EventEmitter();
  telegram.sendMessage = async () => ({ message_id: 10 });
  telegram.editMessage = async () => {};
  telegram.downloadFile = async (fileId, destinationPath) => {
    downloads.push({ fileId, destinationPath });
    return { path: destinationPath, size: 100 };
  };

  const prompts = [];
  const codex = new EventEmitter();
  codex.resumeThread = async () => {};
  codex.readThread = async () => ({
    thread: { cwd: "C:\\Project", status: { type: "idle" }, turns: [] },
  });
  codex.listTurns = async () => ({ data: [] });
  codex.startTurn = async (_threadId, text) => {
    prompts.push(text);
    return { turn: { id: "document-turn" } };
  };

  const bot = new CodexTelegramBot({
    telegram,
    codex,
    stateStore: createStateStore(),
    config: {
      allowedUserId: 7,
      defaultCwd: "C:\\Project",
      desktopSyncPollMs: 1000,
      telegramMaxFileBytes: 0,
      incomingMessageSettleMs: 20,
    },
    logger: createLogger(),
  });

  await bot.handleUpdate({
    message: {
      message_id: 71,
      media_group_id: "album-with-text",
      from: { id: 7 },
      chat: { id: 100 },
      document: { file_id: "file-a", file_name: "a.md", file_size: 100 },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  await bot.handleUpdate({
    message: {
      message_id: 72,
      from: { id: 7 },
      chat: { id: 100 },
      text: "Прочитай именно как UTF-8 и дай сводку.",
    },
  });

  await waitFor(() => prompts.length === 1);

  assert.equal(downloads.length, 1);
  assert.match(prompts[0], /одну составную посылку/);
  assert.match(prompts[0], /71-a\.md/);
  assert.match(prompts[0], /Прочитай именно как UTF-8/);
});

test("Telegram loose documents are batched into one Codex turn", async () => {
  const downloads = [];
  const telegram = new EventEmitter();
  telegram.sendMessage = async () => ({ message_id: downloads.length + 1 });
  telegram.editMessage = async () => {};
  telegram.downloadFile = async (fileId, destinationPath) => {
    downloads.push({ fileId, destinationPath });
    return { path: destinationPath, size: 100 };
  };

  const prompts = [];
  const codex = new EventEmitter();
  codex.resumeThread = async () => {};
  codex.readThread = async () => ({
    thread: { cwd: "C:\\Project", status: { type: "idle" }, turns: [] },
  });
  codex.listTurns = async () => ({ data: [] });
  codex.startTurn = async (_threadId, text) => {
    prompts.push(text);
    return { turn: { id: `document-turn-${prompts.length}` } };
  };

  const bot = new CodexTelegramBot({
    telegram,
    codex,
    stateStore: createStateStore(),
    config: {
      allowedUserId: 7,
      defaultCwd: "C:\\Project",
      desktopSyncPollMs: 1000,
      telegramMaxFileBytes: 0,
      incomingMessageSettleMs: 5,
    },
    logger: createLogger(),
  });

  for (let index = 1; index <= 10; index += 1) {
    await bot.handleUpdate({
      message: {
        message_id: 100 + index,
        from: { id: 7 },
        chat: { id: 100 },
        document: { file_id: `file-${index}`, file_name: `doc-${index}.md`, file_size: 100 },
      },
    });
  }

  await waitFor(() => prompts.length === 1);

  assert.equal(downloads.length, 10);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /101-doc-1\.md/);
  assert.match(prompts[0], /110-doc-10\.md/);
  assert.match(prompts[0], /Process every listed document/);
  assert.match(prompts[0], /Treat uploaded files as read-only/);
});

test("Telegram document batch waits in queue while Codex turn is active", async () => {
  const sent = [];
  const downloads = [];
  const telegram = new EventEmitter();
  telegram.sendMessage = async (chatId, text) => {
    sent.push({ chatId, text });
    return { message_id: sent.length };
  };
  telegram.sendLongMessage = async (chatId, text) => {
    sent.push({ chatId, text });
    return [{ message_id: sent.length }];
  };
  telegram.editMessage = async () => {};
  telegram.downloadFile = async (fileId, destinationPath) => {
    downloads.push({ fileId, destinationPath });
    return { path: destinationPath, size: 100 };
  };

  const prompts = [];
  const codex = new EventEmitter();
  codex.resumeThread = async () => {};
  codex.readThread = async () => ({
    thread: { cwd: "C:\\Project", status: { type: "idle" }, turns: [] },
  });
  codex.listTurns = async () => ({ data: [] });
  codex.startTurn = async (_threadId, text) => {
    prompts.push(text);
    return { turn: { id: `turn-${prompts.length}` } };
  };

  const stateStore = createStateStore();
  const bot = new CodexTelegramBot({
    telegram,
    codex,
    stateStore,
    config: {
      allowedUserId: 7,
      defaultCwd: "C:\\Project",
      desktopSyncPollMs: 1000,
      telegramMaxFileBytes: 0,
      incomingMessageSettleMs: 5,
    },
    logger: createLogger(),
  });

  for (let index = 1; index <= 2; index += 1) {
    await bot.handleUpdate({
      message: {
        message_id: index,
        from: { id: 7 },
        chat: { id: 100 },
        document: { file_id: `first-${index}`, file_name: `first-${index}.md`, file_size: 100 },
      },
    });
  }

  await waitFor(() => prompts.length === 1);

  for (let index = 1; index <= 2; index += 1) {
    await bot.handleUpdate({
      message: {
        message_id: 10 + index,
        from: { id: 7 },
        chat: { id: 100 },
        document: { file_id: `second-${index}`, file_name: `second-${index}.md`, file_size: 100 },
      },
    });
  }

  await waitFor(() => downloads.length === 4);

  assert.equal(prompts.length, 1);
  assert.equal(downloads.length, 4);
  assert.ok(!sent.some((item) => /\/steer/.test(item.text)));

  codex.emit("notification", {
    method: "turn/completed",
    params: { turn: { id: "turn-1", threadId: "thread-1", status: "completed" } },
  });

  await waitFor(() => prompts.length === 2);

  assert.match(prompts[0], /1-first-1\.md/);
  assert.match(prompts[0], /2-first-2\.md/);
  assert.match(prompts[1], /11-second-1\.md/);
  assert.match(prompts[1], /12-second-2\.md/);
});

test("collectOutgoingTelegramFiles returns multiple safe files from allowed root", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-out-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const first = path.join(directory, "first.md");
  const second = path.join(directory, "second.txt");
  const secret = path.join(directory, ".env");
  const logDirectory = path.join(directory, "logs");
  fs.writeFileSync(first, "first");
  fs.writeFileSync(second, "second");
  fs.writeFileSync(secret, "token");
  fs.mkdirSync(logDirectory);
  fs.writeFileSync(path.join(logDirectory, "result.txt"), "log");

  assert.deepEqual(
    collectOutgoingTelegramFiles(
      [
        `Created: ${first}`,
        `Created: ${second}`,
        `Secret: ${secret}`,
        `Log: ${path.join(logDirectory, "result.txt")}`,
      ].join("\n"),
      { roots: [directory] },
    ),
    [first, second].map((filePath) => path.resolve(filePath)),
  );
});

test("collectOutgoingTelegramFiles recognizes Codex markdown and wrapped Windows paths", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-report-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const docs = path.join(directory, "docs");
  fs.mkdirSync(docs);
  const report = path.join(docs, "INDUSTRY_PRACTICE_CHECK_1.md");
  fs.writeFileSync(report, "report");

  const slashPath = report.replace(/\\/g, "/");
  const wrappedPath = report.replace(/^([A-Za-z]:)\\/, "$1\n\\");

  assert.deepEqual(
    collectOutgoingTelegramFiles(
      [
        `Отчёт готов здесь: [INDUSTRY_PRACTICE_CHECK_1.md](${slashPath}:1)`,
        "",
        "Локальный путь для отправки/открытия:",
        "```text",
        wrappedPath,
        "```",
      ].join("\n"),
      { roots: [directory] },
    ),
    [path.resolve(report)],
  );
});

test("Telegram final sends multiple referenced files as documents", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-final-files-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = path.join(directory, "one.md");
  const second = path.join(directory, "two.md");
  fs.writeFileSync(first, "one");
  fs.writeFileSync(second, "two");

  const sentDocuments = [];
  const telegram = new EventEmitter();
  telegram.sendMessage = async () => ({ message_id: 10 });
  telegram.sendLongMessage = async () => [{ message_id: 11 }];
  telegram.editMessage = async () => {};
  telegram.sendDocument = async (chatId, filePath) => {
    sentDocuments.push({ chatId, filePath });
    return { message_id: 20 + sentDocuments.length };
  };

  const codex = new EventEmitter();
  codex.resumeThread = async () => {};
  codex.readThread = async () => ({ thread: { status: { type: "idle" }, turns: [] } });
  codex.listTurns = async () => ({ data: [] });
  let startTurnCalls = 0;
  codex.startTurn = async () => {
    startTurnCalls += 1;
    return { turn: { id: "turn-files" } };
  };

  const stateStore = createStateStore();
  const bot = new CodexTelegramBot({
    telegram,
    codex,
    stateStore,
    config: { allowedUserId: 7, defaultCwd: directory, desktopSyncPollMs: 1000, incomingMessageSettleMs: 1 },
    logger: createLogger(),
  });

  await bot.handleUpdate({
    message: { from: { id: 7 }, chat: { id: 100 }, text: "Make files" },
  });
  await waitFor(() => startTurnCalls === 1);
  codex.emit("notification", {
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-files",
      item: {
        id: "answer-files",
        type: "agentMessage",
        phase: "final_answer",
        text: `Files:\n${first}\n${second}`,
      },
    },
  });
  codex.emit("notification", {
    method: "turn/completed",
    params: { turn: { id: "turn-files", threadId: "thread-1", status: "completed" } },
  });

  await waitFor(() => stateStore.state.telegramFinalDeliveredTurnIds.includes("turn-files"));
  assert.deepEqual(
    sentDocuments.map((item) => [item.chatId, path.resolve(item.filePath)]),
    [
      [100, path.resolve(first)],
      [100, path.resolve(second)],
    ],
  );
});
