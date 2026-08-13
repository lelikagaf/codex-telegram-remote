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
  formatTelegramTurnResult,
  hasActiveTurn,
  isAgentMessage,
  isActiveTurnStatus,
  isDesktopTurnSettled,
  isTerminalTurnStatus,
  isThreadBusy,
  isUnmaterializedThreadError,
  isUserMessage,
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
    config: { allowedUserId: 7, desktopSyncPollMs: 1000 },
    logger: createLogger(),
  });

  await bot.handleUpdate({
    message: { from: { id: 7 }, chat: { id: 100 }, text: "Сделай" },
  });
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
    config: { allowedUserId: 7, desktopSyncPollMs: 1000 },
    logger: createLogger(),
  });

  await bot.handleUpdate({
    message: { from: { id: 7 }, chat: { id: 100 }, text: "Не запускать параллельно" },
  });

  assert.equal(startTurnCalls, 0);
  assert.match(sent.at(-1).text, /чат сейчас занят/);
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
    config: { allowedUserId: 7, desktopSyncPollMs: 1000 },
    logger: createLogger(),
  });

  await bot.handleUpdate({
    message: { from: { id: 7 }, chat: { id: 100 }, text: "Первое сообщение" },
  });

  assert.equal(startTurnCalls, 1);
  assert.equal(sent.at(-1).text, "⏳ Codex начинает работу…");
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
      documentBatchSettleMs: 1,
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
      documentBatchSettleMs: 1,
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
      documentBatchSettleMs: 1,
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
  assert.match(sent.at(-1).text, /Codex/);
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
  codex.startTurn = async () => ({ turn: { id: "turn-files" } });

  const stateStore = createStateStore();
  const bot = new CodexTelegramBot({
    telegram,
    codex,
    stateStore,
    config: { allowedUserId: 7, defaultCwd: directory, desktopSyncPollMs: 1000 },
    logger: createLogger(),
  });

  await bot.handleUpdate({
    message: { from: { id: 7 }, chat: { id: 100 }, text: "Make files" },
  });
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
