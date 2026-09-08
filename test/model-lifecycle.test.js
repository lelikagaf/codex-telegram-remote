const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CodexTelegramBot } = require("../src/bot");
const { CodexClient } = require("../src/codex-client");
const { StateStore } = require("../src/state-store");

const catalog = [
  { model: "model-a", isDefault: true, defaultReasoningEffort: "low",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
  { model: "model-b", defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
  { model: "hidden-model", hidden: true, supportedReasoningEfforts: [] },
];

function setup(t, previous = null) {
  const directory = previous?.directory || fs.mkdtempSync(path.join(os.tmpdir(), "model-lifecycle-"));
  if (!previous) t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const store = new StateStore(path.join(directory, "state.json"), logger);
  store.load();
  const records = previous?.records || new Map();
  const calls = [];
  const sent = [];
  const turnAttempts = [];
  const faults = { settings: false, turn: false, writer: false, read: false, catalog: false };
  const config = { model: "model-a", model_reasoning_effort: "low" };
  const codex = new CodexClient({ launch: {}, cwd: directory, logger });
  Object.defineProperty(codex, "isRunning", { get: () => true });
  // Exercise the real CodexClient methods; only the RPC transport is replaced.
  codex.request = async (method, params) => {
    calls.push({ method, params });
    const record = records.get(params.threadId);
    switch (method) {
      case "model/list":
        if (faults.catalog) throw new Error("catalog unavailable");
        return { data: catalog };
      case "config/read": return { config };
      case "thread/start": {
        const fresh = { id: `new-${records.size + 1}`, name: null, cwd: params.cwd,
          model: config.model, reasoningEffort: config.model_reasoning_effort, loaded: true, materialized: false };
        records.set(fresh.id, fresh);
        return { thread: { ...fresh }, model: fresh.model, reasoningEffort: fresh.reasoningEffort };
      }
      case "thread/name/set": record.name = params.name; return {};
      case "thread/read":
        if (faults.read) throw new Error("read failed");
        assert.ok(record, `Unknown thread ${params.threadId}`);
        assert.equal(params.includeTurns, false);
        return { thread: { id: record.id, name: record.name, cwd: record.cwd, status: { type: "idle" },
          model: record.loaded || record.materialized ? record.model : null,
          reasoningEffort: record.loaded || record.materialized ? record.reasoningEffort : null } };
      case "thread/turns/list":
        if (!record.materialized) throw new Error("invalid paginated history lineage: missing source rollout");
        return { data: [] };
      case "thread/resume":
        if (faults.writer) throw new Error("thread already has an active writer");
        if (!record.loaded && !record.materialized) {
          throw new Error(`thread/resume: no rollout found for thread id ${params.threadId}`);
        }
        record.loaded = true;
        return { model: record.model, reasoningEffort: record.reasoningEffort };
      case "thread/settings/update":
        if (faults.settings) throw new Error("settings failed");
        assert.equal(record.loaded, true);
        if (params.model !== undefined) record.model = params.model;
        if (params.effort !== undefined) record.reasoningEffort = params.effort;
        return {};
      case "thread/unsubscribe": record.loaded = false; return {};
      case "turn/start":
        turnAttempts.push({ threadId: record.id, model: record.model, effort: record.reasoningEffort });
        if (faults.turn) throw new Error("turn failed");
        record.materialized = true;
        return { turn: { id: `turn-${turnAttempts.length}` } };
      default: assert.fail(`Unexpected RPC ${method}`);
    }
  };
  const telegram = new EventEmitter();
  telegram.sendMessage = async (target, text) => {
    sent.push({ target, text });
    return { message_id: sent.length };
  };
  telegram.sendLongMessage = telegram.sendMessage;
  telegram.editMessage = async (target, id, text) => { sent.push({ target, text }); };
  const bot = new CodexTelegramBot({ telegram, codex, stateStore: store, logger,
    config: { allowedUserId: 7, defaultCwd: directory, incomingMessageSettleMs: 1, desktopSyncPollMs: 1000 } });
  t.after(() => bot.stop());
  const command = (text, messageThreadId = null) => bot.handleUpdate({ message: {
    from: { id: 7 }, chat: { id: 100 }, message_thread_id: messageThreadId, text,
  } });
  function select({ id = "orphan", materialized = false, model = "model-a", reasoningEffort = "low", topic = 77 } = {}) {
    const record = { id, name: "Bridge8 UI/UX", cwd: directory, loaded: false, materialized, model, reasoningEffort };
    records.set(id, record);
    const binding = { chatId: 100, messageThreadId: topic, threadId: id, threadName: record.name };
    store.save({ currentThreadId: id, currentThreadName: record.name,
      telegramTopicThreads: topic ? { [`100:${topic}`]: binding } : {},
      telegramThreadTopics: topic ? { [`100:${id}`]: binding } : {} });
    bot.state = store.state;
    return record;
  }
  return { directory, records, store, calls, sent, faults, config, codex, bot, command, select, turnAttempts };
}

async function waitFor(predicate) {
  for (let count = 0; count < 100; count++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Expected bot action did not finish");
}

for (const command of ["/model", "/model@ocume_bot", "/model status"]) {
  test(`${command} works in an orphaned new topic without a resume or unsubscribe`, async (t) => {
    const h = setup(t);
    h.select();
    await h.command(command, 77);
    assert.match(h.sent.at(-1).text, /Модель: model-a/);
    assert.match(h.sent.at(-1).text, /Усилие: low/);
    assert.match(h.sent.at(-1).text, /из конфигурации/);
    assert.deepEqual(h.sent.at(-1).target, { chatId: 100, messageThreadId: 77 });
    assert.equal(h.calls.some((item) => /thread\/(resume|start|unsubscribe)|turn\/start/.test(item.method)), false);
    assert.equal(h.store.state.currentThreadId, "orphan");
  });
}

test("/new followed immediately by /model keeps the empty thread loaded", async (t) => {
  const h = setup(t);
  await h.command("/new Bridge8 UI/UX");
  const id = h.store.state.currentThreadId;
  h.calls.length = 0;
  await h.command("/model");
  assert.match(h.sent.at(-1).text, /Модель: model-a/);
  assert.equal(h.codex.loadedThreads.has(id), true);
  assert.deepEqual(h.calls.map((item) => item.method), ["model/list"]);
  await h.command("First message");
  await waitFor(() => h.turnAttempts.length === 1);
  assert.equal(h.turnAttempts[0].threadId, id);
});

test("/model list is available without selecting or loading a chat", async (t) => {
  const h = setup(t);
  await h.command("/model list");
  assert.match(h.sent.at(-1).text, /model-b/);
  assert.doesNotMatch(h.sent.at(-1).text, /hidden-model/);
  assert.deepEqual(h.calls.map((item) => item.method), ["model/list"]);
});

test("persisted model metadata can be inspected while Desktop owns the writer", async (t) => {
  const h = setup(t);
  h.select({ materialized: true, model: "model-b", reasoningEffort: "medium" });
  h.faults.writer = true;
  await h.command("/model", 77);
  assert.match(h.sent.at(-1).text, /Модель: model-b/);
  assert.match(h.sent.at(-1).text, /Усилие: medium/);
  assert.equal(h.calls.some((item) => item.method === "thread/resume"), false);
});

test("each inspection refreshes unloaded metadata instead of using a stale cache", async (t) => {
  const h = setup(t);
  const record = h.select({ materialized: true });
  await h.command("/model", 77);
  record.model = "model-b";
  record.reasoningEffort = "medium";
  await h.command("/model", 77);
  assert.match(h.sent.at(-1).text, /Модель: model-b/);
  assert.equal(h.calls.filter((item) => item.method === "thread/read").length, 2);
});

test("default settings resolve the selected thread's directory", async (t) => {
  const h = setup(t);
  const record = h.select();
  record.cwd = path.join(h.directory, "project");
  await h.command("/model", 77);
  assert.deepEqual(h.calls.find((item) => item.method === "config/read").params, {
    includeLayers: false, cwd: record.cwd,
  });
});

test("unspecified configuration model uses the server's default catalog model", async (t) => {
  const h = setup(t);
  h.select();
  h.config.model = null;
  h.config.model_reasoning_effort = null;
  await h.command("/model", 77);
  assert.match(h.sent.at(-1).text, /Модель: model-a/);
  assert.match(h.sent.at(-1).text, /low \(по умолчанию\)/);
});

for (const fault of ["read", "catalog"]) {
  test(`${fault} failure is not misreported as Desktop writer contention`, async (t) => {
    const h = setup(t);
    h.select();
    h.faults[fault] = true;
    await h.command("/model", 77);
    assert.match(h.sent.at(-1).text, /Не удалось/);
    assert.doesNotMatch(h.sent.at(-1).text, /Desktop|дождись/);
    assert.equal(h.store.state.currentThreadId, "orphan");
  });
}

for (const value of ["unknown-model", "hidden-model", "model-b ultra", "model-b high extra"]) {
  test(`invalid model selection '${value}' does not change a draft or load it`, async (t) => {
    const h = setup(t);
    h.select();
    await h.command(`/model ${value}`, 77);
    assert.deepEqual(h.store.state.pendingThreadModelSettings, {});
    assert.equal(h.calls.some((item) => /thread\/(resume|start|settings\/update)/.test(item.method)), false);
  });
}

test("changing a persisted chat releases only that topic's writer", async (t) => {
  const h = setup(t);
  h.select({ materialized: true });
  h.store.save({ currentThreadId: "different-global-thread" });
  h.bot.state = h.store.state;
  await h.command("/model model-b high", 77);
  assert.match(h.sent.at(-1).text, /Настройки обновлены/);
  assert.deepEqual(h.calls.filter((item) => item.method === "thread/unsubscribe").map((item) => item.params.threadId), ["orphan"]);
  assert.deepEqual(h.store.state.pendingThreadModelSettings, {});
});

test("actual writer conflict does not save an unapplied model selection", async (t) => {
  const h = setup(t);
  h.select({ materialized: true });
  h.faults.writer = true;
  await h.command("/model model-b high", 77);
  assert.match(h.sent.at(-1).text, /Desktop отпустит чат/);
  assert.deepEqual(h.store.state.pendingThreadModelSettings, {});
});

test("a draft model choice survives restart and is applied before the first turn", async (t) => {
  const h = setup(t);
  await h.command("/new Bridge8 UI/UX", 77);
  const originalId = h.store.state.currentThreadId;
  await h.command("/model model-b high", 77);
  assert.equal(h.calls.some((item) => item.method === "thread/settings/update"), false);
  assert.deepEqual(h.store.state.pendingThreadModelSettings[originalId], { model: "model-b", reasoningEffort: "high" });
  h.bot.stop();
  for (const record of h.records.values()) record.loaded = false;
  const restarted = setup(t, h);
  await restarted.command("/model", 77);
  assert.match(restarted.sent.at(-1).text, /Модель: model-b/);
  assert.match(restarted.sent.at(-1).text, /сохранены для первого сообщения/);
  assert.deepEqual(restarted.calls.map((item) => item.method), ["model/list"]);
  await restarted.command("First user message", 77);
  await waitFor(() => restarted.turnAttempts.length === 1);
  const newId = restarted.store.state.currentThreadId;
  assert.notEqual(newId, originalId);
  assert.deepEqual(restarted.turnAttempts[0], { threadId: newId, model: "model-b", effort: "high" });
  assert.equal(restarted.store.state.telegramTopicThreads["100:77"].threadId, newId);
  assert.equal(restarted.store.state.telegramThreadTopics[`100:${originalId}`], undefined);
  assert.deepEqual(restarted.store.state.pendingThreadModelSettings, {});
  const methods = restarted.calls.map((item) => item.method);
  assert.ok(methods.indexOf("thread/settings/update") < methods.indexOf("turn/start"));
});

test("legacy orphan model change is saved without recreating the chat", async (t) => {
  const h = setup(t);
  h.select();
  await h.command("/model high", 77);
  assert.match(h.sent.at(-1).text, /сохранены для первого сообщения/);
  assert.deepEqual(h.store.state.pendingThreadModelSettings.orphan, { model: "model-a", reasoningEffort: "high" });
  assert.equal(h.records.size, 1);
  await h.command("/model model-b", 77);
  assert.deepEqual(h.store.state.pendingThreadModelSettings.orphan, { model: "model-b", reasoningEffort: "high" });
  await h.command("First message", 77);
  await waitFor(() => h.turnAttempts.length === 1);
  assert.equal(h.turnAttempts[0].model, "model-b");
});

test("switching to a model with incompatible effort selects its default effort", async (t) => {
  const h = setup(t);
  h.select();
  await h.command("/model model-b", 77);
  assert.deepEqual(h.store.state.pendingThreadModelSettings.orphan, { model: "model-b", reasoningEffort: "medium" });
});

test("failed settings update on a persisted chat is not silently stored as a draft", async (t) => {
  const h = setup(t);
  h.select({ materialized: true });
  h.faults.settings = true;
  await h.command("/model model-b high", 77);
  assert.match(h.sent.at(-1).text, /settings failed/);
  assert.deepEqual(h.store.state.pendingThreadModelSettings, {});
  assert.equal(h.records.get("orphan").model, "model-a");
});

test("applying one chat's pending model preserves pending choices for other chats", async (t) => {
  const h = setup(t);
  h.select();
  const other = { model: "model-a", reasoningEffort: "high" };
  h.store.save({ pendingThreadModelSettings: { other } });
  h.bot.state = h.store.state;
  await h.command("/model model-b high", 77);
  await h.command("First message", 77);
  await waitFor(() => h.turnAttempts.length === 1);
  assert.deepEqual(h.store.state.pendingThreadModelSettings, { other });
});

test("failed lookup of both configured and default model does not invent a model", async (t) => {
  const h = setup(t);
  h.select();
  h.config.model = null;
  const request = h.codex.request;
  h.codex.request = async (method, params) => method === "model/list"
    ? { data: [] } : request(method, params);
  await h.command("/model", 77);
  assert.match(h.sent.at(-1).text, /не вернул модель/);
  assert.equal(h.calls.some((item) => item.method === "thread/resume"), false);
});

for (const failure of ["settings", "turn"]) {
  test(`${failure} failure retains pending model settings for a retry`, async (t) => {
    const h = setup(t);
    await h.command("/new Draft", 77);
    await h.command("/model model-b high", 77);
    h.faults[failure] = true;
    await h.command("First message", 77);
    await waitFor(() => h.sent.some((item) => item.text.includes(`${failure} failed`)));
    const id = h.store.state.currentThreadId;
    assert.deepEqual(h.store.state.pendingThreadModelSettings[id], { model: "model-b", reasoningEffort: "high" });
    if (failure === "settings") assert.equal(h.turnAttempts.length, 0);
    h.faults[failure] = false;
    const attempts = h.turnAttempts.length;
    await h.command("Retry message", 77);
    await waitFor(() => h.turnAttempts.length > attempts);
    assert.deepEqual(h.turnAttempts.at(-1), { threadId: id, model: "model-b", effort: "high" });
    assert.deepEqual(h.store.state.pendingThreadModelSettings, {});
  });
}
