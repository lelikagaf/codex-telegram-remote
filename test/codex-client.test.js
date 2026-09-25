const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CHAT_TOOLS_SERVER_NAME,
  DELETION_TOOLS_SERVER_NAME,
  ELEVATION_TOOLS_SERVER_NAME,
  CodexClient,
  buildChatToolsOverrides,
  buildToolOverrides,
  buildCodexAppServerArgs,
} = require("../src/codex-client");

test("app-server starts with default cwd as an additional sandbox directory", () => {
  assert.deepEqual(
    buildCodexAppServerArgs({
      argsPrefix: ["--profile", "telegram"],
      approvalPolicy: "never",
      cwd: "C:\\Users\\lelik\\Documents\\Codex",
    }),
    [
      "--profile",
      "telegram",
      "--ask-for-approval",
      "never",
      "--add-dir",
      "C:\\Users\\lelik\\Documents\\Codex",
      "app-server",
      "--stdio",
    ],
  );
});

test("full access starts app-server without approvals and sandbox", () => {
  assert.deepEqual(
    buildCodexAppServerArgs({
      argsPrefix: [],
      approvalPolicy: "on-request",
      fullAccess: true,
      cwd: "C:\\Users\\lelik\\Documents\\Codex",
    }),
    [
      "--dangerously-bypass-approvals-and-sandbox",
      "--add-dir",
      "C:\\Users\\lelik\\Documents\\Codex",
      "app-server",
      "--stdio",
    ],
  );
});

test("full access overrides approval and sandbox policy for every turn", async () => {
  const client = new CodexClient({
    launch: {},
    cwd: "C:\\Project",
    fullAccess: true,
    logger: { info() {}, debug() {}, warn() {}, error() {} },
  });
  let captured;
  client.request = async (method, params) => {
    captured = { method, params };
    return { turn: { id: "turn-full-access" } };
  };

  await client.startTurn("thread-1", "Сделай");

  assert.deepEqual(captured, {
    method: "turn/start",
    params: {
      threadId: "thread-1",
      input: [{ type: "text", text: "Сделай" }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    },
  });
});

test("model settings are read, cached and updated through app-server", async () => {
  const calls = [];
  const client = new CodexClient({
    launch: {},
    cwd: "C:\\Project",
    logger: { info() {}, debug() {}, warn() {}, error() {} },
  });
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/read") {
      return { thread: { model: "gpt-5.6-sol", reasoningEffort: "low" } };
    }
    if (method === "thread/resume") {
      return { model: "gpt-5.6-sol", reasoningEffort: "low" };
    }
    if (method === "model/list") return { data: [] };
    return {};
  };

  assert.deepEqual(await client.getThreadModelSettings("thread-1"), {
    model: "gpt-5.6-sol",
    reasoningEffort: "low",
  });
  assert.deepEqual(
    await client.updateThreadModelSettings("thread-1", { reasoningEffort: "high" }),
    { model: "gpt-5.6-sol", reasoningEffort: "high" },
  );
  await client.listModels({ includeHidden: true });

  assert.deepEqual(calls, [
    { method: "thread/read", params: { threadId: "thread-1", includeTurns: false } },
    { method: "thread/resume", params: { threadId: "thread-1" } },
    {
      method: "thread/settings/update",
      params: { threadId: "thread-1", effort: "high" },
    },
    { method: "model/list", params: { includeHidden: true } },
  ]);
});

test("full access is applied to new threads, resumed threads and every turn", async () => {
  const calls = [];
  const client = new CodexClient({
    launch: {},
    cwd: "C:\\Project",
    approvalPolicy: "never",
    fullAccess: true,
    logger: { info() {}, debug() {}, warn() {}, error() {} },
  });
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/start") {
      return { thread: { id: "thread-new" }, model: "gpt-5.6-sol", reasoningEffort: "high" };
    }
    if (method === "thread/resume") {
      return { model: "gpt-5.6-sol", reasoningEffort: "high" };
    }
    if (method === "thread/fork") {
      return { thread: { id: "thread-fork" }, model: "gpt-5.6-sol", reasoningEffort: "high" };
    }
    if (method === "turn/start") return { turn: { id: "turn-1" } };
    if (method === "thread/unsubscribe") return { status: "unsubscribed" };
    return {};
  };
  client.child = { killed: false, exitCode: null };

  await client.startThread({ cwd: "C:\\Project" });
  await client.unsubscribeThread("thread-new");
  await client.resumeThread("thread-old");
  await client.forkThread("thread-locked");
  await client.startTurn("thread-old", "Do it");
  await client.unsubscribeThread("thread-old");
  await client.unsubscribeThread("thread-fork");

  assert.deepEqual(calls, [
    {
      method: "thread/start",
      params: {
        cwd: "C:\\Project",
        serviceName: "codex_telegram_remote",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    },
    { method: "thread/unsubscribe", params: { threadId: "thread-new" } },
    {
      method: "thread/resume",
      params: {
        threadId: "thread-old",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    },
    {
      method: "thread/fork",
      params: {
        threadId: "thread-locked",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    },
    {
      method: "turn/start",
      params: {
        threadId: "thread-old",
        input: [{ type: "text", text: "Do it" }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    },
    { method: "thread/unsubscribe", params: { threadId: "thread-old" } },
    { method: "thread/unsubscribe", params: { threadId: "thread-fork" } },
  ]);
  assert.equal(client.loadedThreadCount, 0);
});

test("listTurns falls back to persisted thread history without a writer", async () => {
  const client = new CodexClient({
    launch: {},
    cwd: "C:\\Project",
    logger: { info() {}, debug() {}, warn() {}, error() {} },
  });
  client.request = async (method) => {
    if (method === "thread/turns/list") throw new Error("thread not loaded: thread-1");
    if (method === "thread/read") {
      return {
        thread: {
          turns: [
            { id: "older", status: "completed", startedAt: 10 },
            { id: "newer", status: "completed", startedAt: 20 },
          ],
        },
      };
    }
    return {};
  };

  const result = await client.listTurns("thread-1", { limit: 1 });
  assert.deepEqual(result.data.map((turn) => turn.id), ["newer"]);
});

test("chat tools bridge can be switched on for old and new chats", async () => {
  const launch = {
    command: "C:\\Codex\\codex.exe",
    argsPrefix: ["wrapper"],
  };
  const overrides = buildChatToolsOverrides({
    enabled: true,
    launch,
    cwd: "C:\\Project",
  });
  const server = overrides.config.mcp_servers[CHAT_TOOLS_SERVER_NAME];
  assert.equal(server.command, process.execPath);
  assert.match(server.args[0], /codex-chat-mcp\.js$/);
  assert.equal(server.env.CODEX_CHAT_BRIDGE_COMMAND, launch.command);
  assert.equal(server.env.CODEX_CHAT_BRIDGE_ARGS, '["wrapper"]');
  assert.equal(server.env.CODEX_CHAT_BRIDGE_FULL_ACCESS, "false");
  assert.deepEqual(buildChatToolsOverrides({ enabled: false, launch, cwd: "C:\\Project" }), {});

  const calls = [];
  const client = new CodexClient({
    launch,
    cwd: "C:\\Project",
    appToolsEnabled: true,
    logger: { info() {}, debug() {}, warn() {}, error() {} },
  });
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "new" } };
    if (method === "thread/resume") return {};
    if (method === "thread/fork") return { thread: { id: "fork" } };
    return {};
  };
  await client.startThread({ cwd: "C:\\Project" });
  await client.resumeThread("old");
  await client.forkThread("source");
  for (const call of calls) {
    assert.ok(call.params.config.mcp_servers[CHAT_TOOLS_SERVER_NAME]);
  }
});

test("account rate limits are read through app-server", async () => {
  const client = new CodexClient({
    launch: {},
    cwd: "C:\\Project",
    logger: { info() {}, debug() {}, warn() {}, error() {} },
  });
  let captured;
  client.request = async (method, params) => {
    captured = { method, params };
    return { rateLimits: { limitId: "codex" } };
  };

  const result = await client.getAccountRateLimits();

  assert.deepEqual(captured, {
    method: "account/rateLimits/read",
    params: { excludeResetCreditDetails: true },
  });
  assert.equal(result.rateLimits.limitId, "codex");
});

test("elevation bridge is attached to old and new chats and described in turn context", async () => {
  const launch = { command: "C:\\Codex\\codex.exe", argsPrefix: [] };
  const overrides = buildToolOverrides({
    enabled: false,
    launch,
    cwd: "C:\\Project",
    elevationMode: "ask",
    elevationSpoolPath: "C:\\Spool",
    elevationTaskName: "Elevated Test",
    elevationTimeoutMs: 300_000,
    elevationMaxRuntimeSeconds: 900,
  });
  const server = overrides.config.mcp_servers[ELEVATION_TOOLS_SERVER_NAME];
  assert.match(server.args[0], /codex-elevation-mcp\.js$/);
  assert.equal(server.env.CODEX_ELEVATION_SPOOL_PATH, "C:\\Spool");
  assert.equal(server.env.CODEX_ELEVATION_TASK_NAME, "Elevated Test");
  assert.equal(server.env.CODEX_ELEVATION_TIMEOUT_SECONDS, "300");
  assert.equal(server.env.CODEX_ELEVATION_MAX_RUNTIME_SECONDS, "900");

  const calls = [];
  const client = new CodexClient({
    launch,
    cwd: "C:\\Project",
    elevationMode: "ask",
    elevationSpoolPath: "C:\\Spool",
    logger: { info() {}, debug() {}, warn() {}, error() {} },
  });
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "new" } };
    if (method === "thread/resume") return {};
    return { turn: { id: "turn-1" } };
  };
  await client.startThread({ cwd: "C:\\Project" });
  await client.resumeThread("old");
  await client.startTurn("old", "Проверь powercfg");

  assert.ok(calls[0].params.config.mcp_servers[ELEVATION_TOOLS_SERVER_NAME]);
  assert.ok(calls[1].params.config.mcp_servers[ELEVATION_TOOLS_SERVER_NAME]);
  assert.match(
    calls[2].params.additionalContext["codex-telegram-remote"].value,
    /run_windows_command_as_administrator/,
  );
});

test("deletion bridge is attached to every Telegram chat with automatic approval", async () => {
  const launch = { command: "C:\\Codex\\codex.exe", argsPrefix: [] };
  const overrides = buildToolOverrides({
    enabled: false,
    launch,
    cwd: "C:\\Project",
    deletionAccess: "all",
    deletionMaxRuntimeSeconds: 900,
  });
  const server = overrides.config.mcp_servers[DELETION_TOOLS_SERVER_NAME];
  assert.match(server.args[0], /codex-deletion-mcp\.js$/);
  assert.equal(server.env.CODEX_DELETION_ACCESS, "all");
  assert.equal(server.env.CODEX_DELETION_MAX_RUNTIME_SECONDS, "900");
  assert.equal(server.default_tools_approval_mode, "approve");
  assert.equal(server.tools.delete_local_paths.approval_mode, "approve");
  assert.equal(server.tools.delete_ssh_paths.approval_mode, "approve");

  const calls = [];
  const client = new CodexClient({
    launch,
    cwd: "C:\\Project",
    deletionAccess: "all",
    logger: { info() {}, debug() {}, warn() {}, error() {} },
  });
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "new" } };
    if (method === "thread/resume") return {};
    if (method === "thread/fork") return { thread: { id: "fork" } };
    return { turn: { id: "turn-1" } };
  };
  await client.startThread({ cwd: "C:\\Project" });
  await client.resumeThread("old");
  await client.forkThread("source");
  await client.startTurn("old", "Удали временные файлы");

  for (const call of calls.slice(0, 3)) {
    assert.ok(call.params.config.mcp_servers[DELETION_TOOLS_SERVER_NAME]);
  }
  assert.match(
    calls[3].params.additionalContext["codex-telegram-remote"].value,
    /delete_local_paths/,
  );
  assert.match(
    calls[3].params.additionalContext["codex-telegram-remote"].value,
    /delete_ssh_paths/,
  );
});

test("cross-chat context tells every Telegram turn its current thread ID", async () => {
  const client = new CodexClient({
    launch: {},
    cwd: "C:\\Project",
    appToolsEnabled: true,
    logger: { info() {}, debug() {}, warn() {}, error() {} },
  });
  let call = null;
  client.request = async (method, params) => {
    call = { method, params };
    return { turn: { id: "turn-1" } };
  };

  await client.startTurn("thread-current", "Отправь ID");
  assert.equal(call.method, "turn/start");
  assert.match(
    call.params.additionalContext["codex-telegram-remote"].value,
    /Current Codex thread ID: thread-current/,
  );
  assert.match(call.params.additionalContext["codex-telegram-remote"].value, /send messages/);
});

test("persisted turn pagination uses a local cursor without acquiring a writer", async () => {
  const calls = [];
  const client = new CodexClient({
    launch: {},
    cwd: "C:\\Project",
    logger: { info() {}, debug() {}, warn() {}, error() {} },
  });
  client.request = async (method) => {
    calls.push(method);
    if (method === "thread/read") {
      return { thread: { turns: [
        { id: "third", startedAt: 30 },
        { id: "second", startedAt: 20 },
        { id: "first", startedAt: 10 },
      ] } };
    }
    throw new Error("unexpected request");
  };
  const result = await client.listTurns("thread-1", { limit: 1, cursor: "local:1" });
  assert.deepEqual(result.data.map((turn) => turn.id), ["second"]);
  assert.equal(result.nextCursor, "local:2");
  assert.deepEqual(calls, ["thread/read"]);
});
