const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TOOLS,
  callTool,
  simplifyItem,
  sendMessageToChat,
} = require("../scripts/codex-chat-mcp");

test("MCP bridge advertises cross-chat read and send tools", () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), [
    "codex_list_chats",
    "codex_read_chat",
    "codex_send_message_to_chat",
  ]);
  assert.match(TOOLS[0].description, /do not claim/i);
});

test("codex_list_chats forwards search and pagination", async () => {
  const calls = [];
  const client = {
    async listThreads(options) {
      calls.push(options);
      return { data: [{ id: "thread-1", name: "Amnezia" }], nextCursor: "next" };
    },
  };
  const result = await callTool(client, "codex_list_chats", {
    query: "Amnezia",
    archived: true,
    limit: 500,
    cursor: "cursor",
  });
  assert.deepEqual(calls, [{
    limit: 100,
    cursor: "cursor",
    searchTerm: "Amnezia",
    archived: true,
  }]);
  assert.equal(result.chats[0].id, "thread-1");
  assert.equal(result.nextCursor, "next");
});

test("codex_read_chat returns dialogue and hides technical items by default", async () => {
  const client = {
    async readThread(threadId) {
      return { thread: { id: threadId, name: "Amnezia" } };
    },
    async listTurns() {
      return {
        data: [{
          id: "turn-1",
          status: "completed",
          items: [
            { type: "userMessage", text: "Проверь сервер" },
            { type: "commandExecution", command: "ssh host", aggregatedOutput: "secret" },
            { type: "agentMessage", text: "Готово" },
          ],
        }],
        nextCursor: null,
      };
    },
  };
  const result = await callTool(client, "codex_read_chat", { threadId: "thread-1" });
  assert.deepEqual(result.turns[0].items.map((item) => item.type), ["userMessage", "agentMessage"]);
});

test("technical chat items are bounded when explicitly requested", () => {
  const item = simplifyItem({
    type: "commandExecution",
    command: "x".repeat(5000),
    aggregatedOutput: "y".repeat(7000),
    status: "completed",
  }, true);
  assert.match(item.command, /truncated/);
  assert.match(item.output, /truncated/);
});

test("cross-chat send uses the persistent destination queue", async () => {
  const calls = [];
  const client = {
    async request(method, params, timeoutMs) {
      calls.push({ method, params, timeoutMs });
      return { queuedSubmission: { id: "queued-1" } };
    },
  };

  const result = await sendMessageToChat(client, "thread-2", "Сообщение");
  assert.equal(result.queuedSubmissionId, "queued-1");
  assert.equal(result.status, "queued");
  assert.equal(calls[0].method, "thread/queue/add");
  assert.equal(calls[0].params.threadId, "thread-2");
  assert.equal(calls[0].params.input[0].text, "Сообщение");
  assert.match(calls[0].params.clientUserMessageId, /^[0-9a-f-]{36}$/i);
});
