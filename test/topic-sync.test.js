const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CodexTelegramBot } = require("../src/bot");
const { StateStore } = require("../src/state-store");

const alpha = { id: "alpha", name: "Alpha", cwd: "C:\\Project" };
const beta = { id: "beta", name: "Beta", cwd: "C:\\Project" };

function mapping(chatId, messageThreadId, thread) {
  return { chatId, messageThreadId, threadId: thread.id, threadName: thread.name };
}

function setup(t, { threads = [alpha, beta], state = {}, store } = {}) {
  const sent = [];
  const created = [];
  const reads = [];
  const lists = [];
  const warnings = [];
  const callbacks = [];
  const logger = { info() {}, debug() {}, error() {}, warn: (...args) => warnings.push(args) };
  const telegram = new EventEmitter();
  telegram.sendMessage = async (target, text, extra) => {
    sent.push({ target, text, extra });
    return { message_id: sent.length };
  };
  telegram.createForumTopic = async (chatId, name) => {
    const topic = { message_thread_id: 700 + created.length, name };
    created.push({ chatId, ...topic });
    return topic;
  };
  telegram.answerCallbackQuery = async (id, text) => callbacks.push({ id, text });
  const codex = new EventEmitter();
  codex.listThreads = async ({ limit }) => {
    lists.push(limit);
    return { data: threads.slice(0, limit) };
  };
  codex.readThread = async (id, includeTurns) => {
    reads.push({ id, includeTurns });
    const thread = threads.find((item) => item.id === id);
    if (!thread) throw new Error("thread not found");
    return { thread };
  };
  codex.listTurns = async () => ({ data: [] });
  const stateStore = store || {
    state: { currentThreadId: null, telegramTopicThreads: {}, telegramThreadTopics: {}, ...state },
    save(patch) { this.state = { ...this.state, ...patch }; return this.state; },
  };
  const bot = new CodexTelegramBot({
    telegram, codex, stateStore, logger,
    config: { allowedUserId: 7, defaultCwd: "C:\\Project", desktopSyncPollMs: 1000 },
  });
  t.after(() => bot.stop());
  const command = (text, message = {}) => bot.handleUpdate({
    message: { from: { id: 7 }, chat: { id: 100 }, text, ...message },
  });
  return { bot, telegram, codex, stateStore, command, sent, created, reads, lists, warnings, callbacks };
}

for (const [argument, expected] of [
  ["", 10], ["0", 10], ["1", 1], ["-4", 1], ["25", 25],
  ["50", 50], ["500", 50], ["2.5", 2], ["invalid", 10], ["Infinity", 50],
]) {
  test(`/sync_topics normalizes limit ${JSON.stringify(argument)} to ${expected}`, async (t) => {
    const threads = Array.from({ length: 60 }, (_, i) => ({ id: `t-${i}`, name: `Thread ${i}` }));
    const h = setup(t, { threads });
    await h.command(`/sync_topics ${argument}`);
    assert.deepEqual(h.lists, [expected]);
    assert.equal(h.created.length, expected);
    assert.equal(h.stateStore.state.lastListedThreadIds.length, expected);
  });
}

test("empty Codex list without a selection creates no topics", async (t) => {
  const h = setup(t, { threads: [] });
  await h.command("/sync_topics");
  assert.deepEqual(h.created, []);
  assert.deepEqual(h.reads, []);
  assert.match(h.sent.at(-1).text, /Создано: 0\. Уже было: 0/);
});

test("missing optional list data is handled as an empty list", async (t) => {
  const h = setup(t);
  h.codex.listThreads = async () => ({});
  await h.command("/sync_topics");
  assert.deepEqual(h.created, []);
  assert.deepEqual(h.stateStore.state.lastListedThreadIds, []);
});

test("a listed selected chat is not read again or added twice", async (t) => {
  const h = setup(t, { state: { currentThreadId: beta.id } });
  await h.command("/sync_topics");
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.created.map((item) => item.name), ["Alpha", "Beta"]);
  assert.deepEqual(h.stateStore.state.lastListedThreadIds, [alpha.id, beta.id]);
});

test("selected chat is synchronized when the recent list is empty", async (t) => {
  const h = setup(t, { threads: [], state: { currentThreadId: alpha.id } });
  h.codex.readThread = async () => ({ thread: alpha });
  await h.command("/sync_topics");
  assert.deepEqual(h.created.map((item) => item.name), ["Alpha"]);
  assert.equal(h.stateStore.state.telegramThreadTopics["100:alpha"].messageThreadId, 700);
});

for (const error of [
  "thread/turns/list is unavailable before first user message",
  "invalid paginated history lineage: missing source rollout",
]) {
  test(`selected chat without history retains its saved name: ${error}`, async (t) => {
    const h = setup(t, { state: { currentThreadId: "fresh", currentThreadName: "Fresh chat" } });
    h.codex.readThread = async () => { throw new Error(error); };
    await h.command("/sync_topics 1");
    assert.deepEqual(h.created.map((item) => item.name), ["Fresh chat"]);
    assert.deepEqual(h.warnings, []);
    assert.equal(h.stateStore.state.telegramTopicThreads["100:700"].threadId, "fresh");
  });
}

test("unrelated read failure is logged and does not fabricate a topic", async (t) => {
  const h = setup(t, { state: { currentThreadId: "unavailable", currentThreadName: "Unavailable" } });
  h.codex.readThread = async () => { throw new Error("connection reset"); };
  await h.command("/sync_topics");
  assert.deepEqual(h.created.map((item) => item.name), ["Alpha", "Beta"]);
  assert.equal(h.warnings.length, 1);
  assert.equal(h.stateStore.state.telegramThreadTopics["100:unavailable"], undefined);
});

test("Codex list failure leaves previous listings and mappings intact", async (t) => {
  const h = setup(t, { state: { lastListedThreadIds: ["previous"] } });
  h.codex.listThreads = async () => { throw new Error("Codex unavailable"); };
  await assert.rejects(h.command("/sync_topics"), /Codex unavailable/);
  assert.deepEqual(h.created, []);
  assert.deepEqual(h.stateStore.state.lastListedThreadIds, ["previous"]);
  assert.deepEqual(h.stateStore.state.telegramTopicThreads, {});
});

test("unsupported forum client reports the problem before calling Codex", async (t) => {
  const h = setup(t);
  delete h.telegram.createForumTopic;
  await h.command("/sync_topics");
  assert.deepEqual(h.lists, []);
  assert.match(h.sent.at(-1).text, /не поддерживает/);
});

test("sync in a mapped topic uses its selected chat and replies in that topic", async (t) => {
  const topic = mapping(100, 77, beta);
  const h = setup(t, { threads: [alpha], state: {
    currentThreadId: alpha.id,
    telegramTopicThreads: { "100:77": topic },
    telegramThreadTopics: { "100:beta": topic },
  } });
  h.codex.readThread = async (id) => {
    assert.equal(id, beta.id);
    return { thread: beta };
  };
  await h.command("/sync_topics 1", { message_thread_id: 77 });
  assert.deepEqual(h.created, []);
  assert.deepEqual(h.stateStore.state.lastListedThreadIds, [beta.id]);
  assert.deepEqual(h.sent.at(-1).target, { chatId: 100, messageThreadId: 77 });
  assert.equal(h.stateStore.state.currentThreadId, alpha.id);
});

test("history fallback in a topic uses its saved name instead of the global selection", async (t) => {
  const topic = mapping(100, 77, beta);
  const h = setup(t, { threads: [alpha], state: {
    currentThreadId: alpha.id, currentThreadName: alpha.name,
    telegramTopicThreads: { "100:77": topic },
    telegramThreadTopics: { "100:beta": topic },
  } });
  h.codex.readThread = async () => {
    throw new Error("thread/turns/list is unavailable before first user message");
  };
  await h.command("/chats", { message_thread_id: 77 });
  assert.match(h.sent.at(-1).text, /● 1\. Beta/);
  assert.equal(h.sent.at(-1).extra.reply_markup.inline_keyboard[0][0].callback_data, "use:beta");
});

test("chat list text and keyboard agree on the selection inside a topic", async (t) => {
  const h = setup(t, { state: {
    currentThreadId: alpha.id,
    telegramTopicThreads: { "100:77": mapping(100, 77, beta) },
  } });
  await h.command("/chats", { message_thread_id: 77 });
  const response = h.sent.at(-1);
  assert.match(response.text, /● 2\. Beta/);
  assert.match(response.extra.reply_markup.inline_keyboard[1][0].text, /^●/);
  assert.match(response.extra.reply_markup.inline_keyboard[0][0].text, /^○/);
});

test("the same Codex chat gets independent topic mappings in two Telegram groups", async (t) => {
  const h = setup(t, { threads: [alpha] });
  await h.command("/sync_topics", { chat: { id: -100111 } });
  await h.command("/sync_topics", { chat: { id: -100222 } });
  assert.deepEqual(h.created.map((item) => item.chatId), [-100111, -100222]);
  assert.equal(h.stateStore.state.telegramThreadTopics["-100111:alpha"].messageThreadId, 700);
  assert.equal(h.stateStore.state.telegramThreadTopics["-100222:alpha"].messageThreadId, 701);
});

test("different Codex chats with identical titles are not merged", async (t) => {
  const h = setup(t, { threads: [alpha, { ...beta, name: alpha.name }] });
  await h.command("/sync_topics");
  assert.equal(h.created.length, 2);
  assert.notEqual(
    h.stateStore.state.telegramThreadTopics["100:alpha"].messageThreadId,
    h.stateStore.state.telegramThreadTopics["100:beta"].messageThreadId,
  );
});

test("a reverse mapping with a missing forward mapping is repaired", async (t) => {
  const h = setup(t, { threads: [alpha], state: {
    telegramThreadTopics: { "100:alpha": mapping(100, 77, alpha) },
  } });
  await h.command("/sync_topics");
  assert.equal(h.created.length, 1);
  assert.equal(h.stateStore.state.telegramThreadTopics["100:alpha"].messageThreadId, 700);
});

test("rebinding a topic preserves the old chat's valid mapping to a different topic", async (t) => {
  const h = setup(t, { state: {
    telegramTopicThreads: { "100:77": mapping(100, 77, alpha), "100:88": mapping(100, 88, alpha) },
    telegramThreadTopics: { "100:alpha": mapping(100, 88, alpha) },
  } });
  await h.command("/chats");
  await h.command("/use 2", { message_thread_id: 77 });
  assert.equal(h.stateStore.state.telegramThreadTopics["100:alpha"].messageThreadId, 88);
  assert.equal(h.stateStore.state.telegramTopicThreads["100:77"].threadId, beta.id);
  assert.equal(h.stateStore.state.telegramThreadTopics["100:beta"].messageThreadId, 77);
});

for (const failureAt of [0, 1]) {
  test(`partial topic failure at item ${failureAt + 1} resumes after a persisted restart`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "topic-sync-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const statePath = path.join(directory, "state.json");
    const store = new StateStore(statePath, { warn() {} });
    store.load();
    const h = setup(t, { store });
    const createTopic = h.telegram.createForumTopic;
    let calls = 0;
    h.telegram.createForumTopic = async (...args) => {
      if (calls++ === failureAt) throw new Error("Telegram: not enough rights");
      return createTopic(...args);
    };
    await h.command("/sync_topics");
    assert.equal(h.created.length, failureAt);
    assert.match(h.sent.at(-1).text, /не удалось создать тему/i);
    assert.doesNotMatch(h.sent.at(-1).text, /Синхронизация тем завершена/);

    const restored = new StateStore(statePath, { warn() {} });
    restored.load();
    const restarted = setup(t, { store: restored });
    restarted.telegram.createForumTopic = async (chatId, name) => {
      const topic = { message_thread_id: 800 + restarted.created.length, name };
      restarted.created.push({ chatId, ...topic });
      return topic;
    };
    await restarted.command("/sync_topics");
    assert.deepEqual(restarted.created.map((item) => item.name), [alpha, beta].slice(failureAt).map((item) => item.name));
    assert.equal(Object.keys(restored.state.telegramTopicThreads).length, 2);
    if (failureAt) assert.equal(restored.state.telegramThreadTopics["100:alpha"].messageThreadId, 700);
  });
}

test("failed summary delivery does not recreate successfully saved topics on retry", async (t) => {
  const h = setup(t);
  const send = h.telegram.sendMessage;
  h.telegram.sendMessage = async () => { throw new Error("send failed"); };
  await assert.rejects(h.command("/sync_topics"), /send failed/);
  h.telegram.sendMessage = send;
  await h.command("/sync_topics");
  assert.equal(h.created.length, 2);
  assert.match(h.sent.at(-1).text, /Создано: 0\. Уже было: 2/);
});

for (const command of ["/new Test", "/chats", "/sync_topics"]) {
  test(`unauthorized ${command} cannot read Codex or mutate topic bindings`, async (t) => {
    const h = setup(t);
    h.codex.startThread = async () => assert.fail("Unauthorized thread creation");
    await h.command(command, { from: { id: 999 } });
    assert.deepEqual(h.lists, []);
    assert.deepEqual(h.created, []);
    assert.deepEqual(h.stateStore.state.telegramTopicThreads, {});
    assert.match(h.sent.at(-1).text, /Доступ запрещ/);
  });
}

test("unauthorized topic selection callback leaves mappings untouched", async (t) => {
  const h = setup(t);
  await h.bot.handleUpdate({ callback_query: {
    id: "callback", from: { id: 999 }, data: "use:beta",
    message: { chat: { id: 100 }, message_thread_id: 77 },
  } });
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.stateStore.state.telegramTopicThreads, {});
  assert.match(h.callbacks[0].text, /Доступ запрещ/);
});

test("authorized selection callback binds the chat to the originating topic", async (t) => {
  const h = setup(t);
  await h.bot.handleUpdate({ callback_query: {
    id: "callback", from: { id: 7 }, data: "use:beta",
    message: { chat: { id: 100 }, message_thread_id: 77 },
  } });
  assert.equal(h.stateStore.state.telegramTopicThreads["100:77"].threadId, beta.id);
  assert.deepEqual(h.sent.at(-1).target, { chatId: 100, messageThreadId: 77 });
  assert.equal(h.callbacks[0].id, "callback");
});

for (const service of [
  "forum_topic_edited", "forum_topic_closed", "forum_topic_reopened",
  "general_forum_topic_hidden", "general_forum_topic_unhidden", "pinned_message",
]) {
  test(`Telegram service event ${service} does not run an attached command`, async (t) => {
    const h = setup(t);
    await h.command("/sync_topics", { [service]: {} });
    assert.deepEqual(h.created, []);
    assert.deepEqual(h.lists, []);
    assert.deepEqual(h.sent, []);
  });
}

test("new thread creation failure retains the selected chat and its topic", async (t) => {
  const topic = mapping(100, 77, alpha);
  const h = setup(t, { state: {
    currentThreadId: alpha.id, telegramTopicThreads: { "100:77": topic },
    telegramThreadTopics: { "100:alpha": topic },
  } });
  h.codex.startThread = async () => { throw new Error("start failed"); };
  await assert.rejects(h.command("/new Test", { message_thread_id: 77 }), /start failed/);
  assert.equal(h.stateStore.state.currentThreadId, alpha.id);
  assert.deepEqual(h.stateStore.state.telegramTopicThreads["100:77"], topic);
  assert.deepEqual(h.sent, []);
});
