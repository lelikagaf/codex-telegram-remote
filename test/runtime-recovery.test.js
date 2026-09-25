const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const { CodexClient, CHAT_TOOLS_SERVER_NAME } = require("../src/codex-client");
const { missingRuntimeFiles, parseVersion, selectCodexCandidate } = require("../src/codex-binary");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-runtime-"));
  const makeRuntime = (name) => {
    const dir = path.join(directory, name);
    fs.mkdirSync(dir);
    const command = path.join(dir, "codex.exe");
    const host = path.join(dir, "codex-code-mode-host.exe");
    fs.writeFileSync(command, "fake executable");
    fs.writeFileSync(host, "fake host");
    return { command, host, source: "Codex Desktop", argsPrefix: [], version: parseVersion("0.155.0"), codeModeHostAvailable: true };
  };
  const old = makeRuntime("old");
  const next = makeRuntime("next");
  const calls = [];
  const children = [];
  const held = new Map();
  const holds = new Set();
  const failures = new Map();
  const h = { old, next, selected: old, resolutions: 0, calls, children, holds, held, failures };
  const spawnProcess = (command) => {
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), killed: false, exitCode: null });
    child.notify = (method, params) => child.stdout.write(JSON.stringify({ method, params }) + "\n");
    child.kill = () => { child.killed = true; return true; };
    child.stdin = new Writable({ write(chunk, encoding, done) {
      const request = JSON.parse(String(chunk));
      calls.push({ command, ...request });
      if (request.id !== undefined) {
        const reply = () => {
          const method = request.method;
          const error = failures.get(method);
          let result = {};
          if (method === "thread/resume") result = { thread: { id: request.params.threadId, status: { type: "idle" } }, model: "model-a", reasoningEffort: "low" };
          if (method === "thread/start" || method === "thread/fork") result = { thread: { id: "new" }, model: "model-a", reasoningEffort: "low" };
          if (method === "turn/start") result = { turn: { id: "turn-1", status: "inProgress" } };
          child.stdout.write(JSON.stringify({ id: request.id, ...(error ? { error: { message: error } } : { result }) }) + "\n");
        };
        if (holds.has(request.method)) held.set(request.method, reply);
        else queueMicrotask(reply);
      }
      done();
    } });
    children.push(child);
    return child;
  };
  h.client = new CodexClient({ launch: old, resolveLaunch: () => {
    h.resolutions++;
    if (h.resolveError) throw new Error(h.resolveError);
    return h.selected;
  }, spawnProcess, cwd: directory, appToolsEnabled: true,
  logger: { info() {}, warn() {}, debug() {}, error() {} } });
  t.after(() => { h.client.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  return h;
}

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Expected RPC was not reached");
}

test("runtime health detects a removed host, executable, and directories masquerading as files", (t) => {
  const h = fixture(t);
  assert.deepEqual(missingRuntimeFiles(h.old), []);
  fs.unlinkSync(h.old.host);
  assert.deepEqual(missingRuntimeFiles(h.old), [h.old.host]);
  fs.mkdirSync(h.old.host);
  assert.deepEqual(missingRuntimeFiles(h.old), [h.old.host]);
  fs.unlinkSync(h.old.command);
  assert.deepEqual(missingRuntimeFiles(h.old), [h.old.command, h.old.host]);
});

test("npm fallback validates its entry point without requiring a Windows host", (t) => {
  const h = fixture(t);
  const launch = { command: process.execPath, source: "npm fallback", argsPrefix: [h.old.host] };
  assert.deepEqual(missingRuntimeFiles(launch), []);
  fs.unlinkSync(h.old.host);
  assert.deepEqual(missingRuntimeFiles(launch), [h.old.host]);
});

test("candidate selection skips a newer incomplete runtime", () => {
  const healthy = { version: parseVersion("1.0.0"), codeModeHostAvailable: true };
  const incomplete = { version: parseVersion("2.0.0"), codeModeHostAvailable: false };
  assert.equal(selectCodexCandidate([incomplete, healthy]), healthy);
  assert.equal(selectCodexCandidate([incomplete, null]), null);
});

test("candidate selection keeps version ordering among complete runtimes and permits npm", () => {
  const older = { version: parseVersion("1.0.0"), codeModeHostAvailable: true };
  const newer = { version: parseVersion("2.0.0"), codeModeHostAvailable: true };
  const npm = { version: parseVersion("3.0.0"), codeModeHostAvailable: null };
  assert.equal(selectCodexCandidate([older, newer]), newer);
  assert.equal(selectCodexCandidate([older, newer, npm]), npm);
});

test("each app-server start rediscovers the runtime", async (t) => {
  const h = fixture(t);
  await h.client.ensureStarted();
  h.client.stop();
  h.selected = h.next;
  await h.client.ensureStarted();
  assert.equal(h.resolutions, 2);
  assert.equal(h.client.launch.command, h.next.command);
});

test("healthy running runtime is not restarted or rediscovered for each command", async (t) => {
  const h = fixture(t);
  await h.client.ensureStarted();
  await h.client.ensureRuntimeReady();
  await h.client.resumeThread("saved");
  assert.equal(h.resolutions, 1);
  assert.equal(h.children.length, 1);
});

for (const removed of ["host", "command"]) {
  test(`missing ${removed} recovers before a cached thread turn, with current MCP paths and model`, async (t) => {
    const h = fixture(t);
    await h.client.resumeThread("saved");
    await h.client.updateThreadModelSettings("saved", { model: "model-b", reasoningEffort: "high" });
    fs.unlinkSync(h.old[removed]);
    h.selected = h.next;
    await h.client.startTurn("saved", "continue document 17");
    assert.equal(h.children[0].killed, true);
    const resumed = h.calls.filter((c) => c.method === "thread/resume");
    assert.equal(resumed.length, 2);
    assert.equal(resumed[1].params.threadId, "saved");
    assert.equal(resumed[1].params.config.mcp_servers[CHAT_TOOLS_SERVER_NAME].env.CODEX_CHAT_BRIDGE_COMMAND, h.next.command);
    const restored = h.calls.find((c) => c.command === h.next.command && c.method === "thread/settings/update");
    assert.deepEqual(restored.params, { threadId: "saved", model: "model-b", effort: "high" });
    const turns = h.calls.filter((c) => c.method === "turn/start");
    assert.equal(turns.length, 1);
    assert.equal(turns[0].command, h.next.command);
  });
}

test("active turns are never interrupted by runtime recovery; stop still works", async (t) => {
  const h = fixture(t);
  await h.client.startTurn("saved", "work");
  fs.unlinkSync(h.old.host);
  h.selected = h.next;
  await assert.rejects(h.client.ensureRuntimeReady(), /выполняющаяся задача/);
  assert.equal(h.children[0].killed, false);
  await h.client.interruptTurn("saved", "turn-1");
  h.children[0].notify("turn/completed", { threadId: "saved", turn: { id: "turn-1", status: "interrupted" } });
  await h.client.ensureRuntimeReady();
  assert.equal(h.client.launch.command, h.next.command);
  assert.equal(h.calls.filter((c) => c.method === "turn/start").length, 1);
});

test("turn notifications protect an active task recovered through thread resume", async (t) => {
  const h = fixture(t);
  await h.client.ensureStarted();
  h.children[0].notify("turn/started", { threadId: "recovered", turn: { id: "t" } });
  fs.unlinkSync(h.old.host);
  await assert.rejects(h.client.ensureRuntimeReady(), /выполняющаяся задача/);
  assert.equal(h.children[0].killed, false);
});

test("runtime recovery waits for a pending read instead of dropping its result", async (t) => {
  const h = fixture(t);
  await h.client.ensureStarted();
  h.holds.add("thread/read");
  const read = h.client.readThread("saved");
  await waitFor(() => h.held.has("thread/read"));
  fs.unlinkSync(h.old.host);
  h.selected = h.next;
  const recovery = h.client.ensureRuntimeReady();
  assert.equal(h.children[0].killed, false);
  h.held.get("thread/read")();
  await read;
  await recovery;
  assert.equal(h.children.length, 2);
});

test("concurrent recovery requests start exactly one replacement", async (t) => {
  const h = fixture(t);
  await h.client.ensureStarted();
  fs.unlinkSync(h.old.host);
  h.selected = h.next;
  await Promise.all([h.client.ensureRuntimeReady(), h.client.ensureRuntimeReady(), h.client.resumeThread("saved")]);
  assert.equal(h.children.length, 2);
});

test("concurrent RPCs wait for initialization before sending any other request", async (t) => {
  const h = fixture(t);
  h.holds.add("initialize");
  const first = h.client.readThread("a");
  await waitFor(() => h.held.has("initialize"));
  const second = h.client.readThread("b");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.calls.map((c) => c.method), ["initialize"]);
  h.held.get("initialize")();
  await Promise.all([first, second]);
  assert.deepEqual(h.calls.map((c) => c.method), ["initialize", "initialized", "thread/read", "thread/read"]);
});

test("delayed exit and stdout from old process cannot disconnect the replacement", async (t) => {
  const h = fixture(t);
  await h.client.ensureStarted();
  fs.unlinkSync(h.old.host);
  h.selected = h.next;
  await h.client.ensureRuntimeReady();
  let disconnects = 0;
  h.client.on("disconnected", () => disconnects++);
  h.children[0].emit("exit", 1, null);
  h.children[0].emit("error", new Error("late error"));
  h.children[0].notify("turn/started", { threadId: "ghost" });
  await h.client.readThread("saved");
  assert.equal(h.client.isRunning, true);
  assert.equal(h.client.activeTurnThreads.has("ghost"), false);
  assert.equal(disconnects, 0);
});

test("a partial or pinned missing replacement never receives user input", async (t) => {
  const h = fixture(t);
  await h.client.ensureStarted();
  fs.unlinkSync(h.old.host);
  await assert.rejects(h.client.startTurn("saved", "work"), /Неполный комплект/);
  assert.equal(h.calls.filter((c) => c.method === "turn/start").length, 0);
  h.selected = h.next;
  await h.client.startTurn("saved", "work");
  assert.equal(h.calls.filter((c) => c.method === "turn/start").length, 1);
});

test("failed discovery is retryable without a bot restart", async (t) => {
  const h = fixture(t);
  h.resolveError = "update in progress";
  await assert.rejects(h.client.ensureRuntimeReady(), /update in progress/);
  h.resolveError = null;
  await h.client.ensureRuntimeReady();
  assert.equal(h.client.isRunning, true);
});

test("failed handshake closes its process and a later request can reconnect", async (t) => {
  const h = fixture(t);
  h.failures.set("initialize", "initialize rejected");
  await assert.rejects(h.client.ensureStarted(), /initialize rejected/);
  assert.equal(h.children[0].killed, true);
  h.failures.clear();
  await h.client.ensureStarted();
  assert.equal(h.client.isRunning, true);
});

test("rejected turn is not replayed and does not leave runtime recovery permanently busy", async (t) => {
  const h = fixture(t);
  h.failures.set("turn/start", "turn rejected");
  await assert.rejects(h.client.startTurn("saved", "work"), /turn rejected/);
  fs.unlinkSync(h.old.host);
  h.selected = h.next;
  await h.client.ensureRuntimeReady();
  assert.equal(h.children.length, 2);
  assert.equal(h.calls.filter((c) => c.method === "turn/start").length, 1);
});

test("failure to restore model settings is retryable before submitting a turn", async (t) => {
  const h = fixture(t);
  await h.client.updateThreadModelSettings("saved", { model: "model-b", reasoningEffort: "high" });
  fs.unlinkSync(h.old.host);
  h.selected = h.next;
  h.failures.set("thread/settings/update", "settings rejected");
  await assert.rejects(h.client.startTurn("saved", "work"), /settings rejected/);
  assert.equal(h.calls.filter((c) => c.method === "turn/start").length, 0);
  h.failures.clear();
  await h.client.startTurn("saved", "work");
  assert.deepEqual(h.client.threadModelSettings.get("saved"), { model: "model-b", reasoningEffort: "high" });
});

test("a submitted turn awaiting its RPC response is already protected from restart", async (t) => {
  const h = fixture(t);
  h.holds.add("turn/start");
  const turn = h.client.startTurn("saved", "work");
  await waitFor(() => h.held.has("turn/start"));
  fs.unlinkSync(h.old.host);
  h.selected = h.next;
  await assert.rejects(h.client.ensureRuntimeReady(), /выполняющаяся задача/);
  assert.equal(h.children[0].killed, false);
  h.held.get("turn/start")();
  await turn;
});

for (const method of ["startThread", "forkThread"]) {
  test(`${method} uses fresh MCP paths after runtime replacement`, async (t) => {
    const h = fixture(t);
    await h.client.ensureStarted();
    fs.unlinkSync(h.old.host);
    h.selected = h.next;
    if (method === "startThread") await h.client.startThread({ cwd: "project" });
    else await h.client.forkThread("saved");
    const call = h.calls.find((c) => c.method === (method === "startThread" ? "thread/start" : "thread/fork"));
    assert.equal(call.command, h.next.command);
    assert.equal(call.params.config.mcp_servers[CHAT_TOOLS_SERVER_NAME].env.CODEX_CHAT_BRIDGE_COMMAND, h.next.command);
    assert.equal(call.params.config.mcp_servers[CHAT_TOOLS_SERVER_NAME].env.CODEX_CHAT_BRIDGE_AUTO_DISCOVER, "true");
  });
}

test("intentional stop rejects pending RPCs immediately", async (t) => {
  const h = fixture(t);
  await h.client.ensureStarted();
  h.holds.add("thread/read");
  const read = h.client.readThread("saved");
  const rejected = assert.rejects(read, /остановлен/);
  await waitFor(() => h.held.has("thread/read"));
  h.client.stop();
  await rejected;
  assert.equal(h.client.pending.size, 0);
});
