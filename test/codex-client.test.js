const test = require("node:test");
const assert = require("node:assert/strict");
const { CodexClient, buildCodexAppServerArgs } = require("../src/codex-client");

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

test("model settings are read, cached and updated through app-server", async () => {
  const calls = [];
  const client = new CodexClient({
    launch: {},
    cwd: "C:\\Project",
    logger: { info() {}, debug() {}, warn() {}, error() {} },
  });
  client.request = async (method, params) => {
    calls.push({ method, params });
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
    { method: "thread/resume", params: { threadId: "thread-1" } },
    {
      method: "thread/settings/update",
      params: { threadId: "thread-1", effort: "high" },
    },
    { method: "model/list", params: { includeHidden: true } },
  ]);
});
