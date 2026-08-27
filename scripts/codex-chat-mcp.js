#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const readline = require("node:readline");
const { CodexClient } = require("../src/codex-client");

const SERVER_INFO = { name: "codex-telegram-chats", version: "0.1.0" };
const MAX_TEXT_LENGTH = 12_000;

const TOOLS = [
  {
    name: "codex_list_chats",
    description:
      "List Codex chats from this computer. Use this whenever the user mentions another chat, task, thread, or conversation; do not claim that other chats are inaccessible before trying this tool.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional substring of the chat title." },
        archived: { type: "boolean", description: "List archived chats instead of active chats." },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        cursor: { type: "string", description: "Pagination cursor from the previous result." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "codex_read_chat",
    description:
      "Read a Codex chat from this computer by thread ID. First use codex_list_chats when only a title is known. Results are paginated; follow nextCursor when more history is needed.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", minLength: 1, description: "Codex thread ID." },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        cursor: { type: "string", description: "Pagination cursor from the previous result." },
        includeTechnicalItems: {
          type: "boolean",
          default: false,
          description: "Include bounded command, file-change, and MCP-call metadata.",
        },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
  },
  {
    name: "codex_send_message_to_chat",
    description:
      "Queue a user-requested message in another Codex chat. Use this when the user explicitly asks to write, send, continue, or relay something in a different Codex chat. The destination receives it even when that chat is currently busy. The current chat ID is provided in application context.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", minLength: 1, description: "Destination Codex thread ID." },
        message: { type: "string", minLength: 1, description: "Exact message to send." },
      },
      required: ["threadId", "message"],
      additionalProperties: false,
    },
  },
];

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function boundedText(value, limit = MAX_TEXT_LENGTH) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated]`;
}

function itemText(item) {
  if (typeof item?.text === "string") return boundedText(item.text);
  if (!Array.isArray(item?.content)) return "";
  return boundedText(
    item.content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n"),
  );
}

function simplifyItem(item, includeTechnicalItems = false) {
  const type = item?.type || "unknown";
  if (type === "userMessage" || type === "agentMessage") {
    return { type, text: itemText(item), ...(item.phase ? { phase: item.phase } : {}) };
  }
  if (type === "reasoning") {
    const summary = boundedText(item.summary || itemText(item));
    return summary ? { type, summary } : null;
  }
  if (!includeTechnicalItems) return null;
  if (type === "commandExecution") {
    return {
      type,
      command: boundedText(item.command, 4000),
      status: item.status || null,
      output: boundedText(item.aggregatedOutput || item.output, 6000),
    };
  }
  if (type === "mcpToolCall") {
    return {
      type,
      server: item.server || null,
      tool: item.tool || null,
      status: item.status || null,
      arguments: boundedText(item.arguments, 4000),
      result: boundedText(item.result || item.error, 6000),
    };
  }
  if (type === "fileChange") {
    return { type, status: item.status || null, changes: item.changes || [] };
  }
  return { type, status: item.status || null };
}

function simplifyTurn(turn, includeTechnicalItems = false) {
  return {
    id: turn.id,
    status: turn.status,
    startedAt: turn.startedAt ?? null,
    completedAt: turn.completedAt ?? null,
    items: (turn.items || [])
      .map((item) => simplifyItem(item, includeTechnicalItems))
      .filter(Boolean),
  };
}

function simplifyThread(thread) {
  return {
    id: thread.id,
    name: thread.name || null,
    preview: boundedText(thread.preview, 1000) || null,
    cwd: thread.cwd || null,
    status: thread.status || null,
    createdAt: thread.createdAt ?? null,
    updatedAt: thread.updatedAt ?? null,
  };
}

function createBridgeClient() {
  const command = process.env.CODEX_CHAT_BRIDGE_COMMAND;
  if (!command) throw new Error("CODEX_CHAT_BRIDGE_COMMAND is not configured");
  let argsPrefix = [];
  try {
    argsPrefix = JSON.parse(process.env.CODEX_CHAT_BRIDGE_ARGS || "[]");
  } catch {
    throw new Error("CODEX_CHAT_BRIDGE_ARGS is invalid");
  }
  return new CodexClient({
    launch: { command, argsPrefix, version: { raw: "chat-bridge" } },
    cwd: process.env.CODEX_CHAT_BRIDGE_CWD || process.cwd(),
    approvalPolicy: "never",
    fullAccess: /^(1|true|yes|on)$/i.test(process.env.CODEX_CHAT_BRIDGE_FULL_ACCESS || ""),
    appToolsEnabled: false,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
}

async function sendMessageToChat(client, threadId, message) {
  const result = await client.request("thread/queue/add", {
    threadId,
    clientUserMessageId: crypto.randomUUID(),
    input: [{ type: "text", text: message }],
  }, 120_000);
  return {
    threadId,
    queuedSubmissionId: result.queuedSubmission?.id || null,
    status: "queued",
  };
}

async function callTool(client, name, args = {}) {
  if (name === "codex_list_chats") {
    const result = await client.listThreads({
      limit: clampInteger(args.limit, 20, 1, 100),
      cursor: args.cursor || null,
      searchTerm: String(args.query || "").trim() || null,
      archived: Boolean(args.archived),
    });
    return {
      chats: (result.data || []).map(simplifyThread),
      nextCursor: result.nextCursor || null,
    };
  }
  if (name === "codex_read_chat") {
    const threadId = String(args.threadId || "").trim();
    if (!threadId) throw new Error("threadId is required");
    const [threadResult, turnsResult] = await Promise.all([
      client.readThread(threadId, false),
      client.listTurns(threadId, {
        limit: clampInteger(args.limit, 20, 1, 50),
        cursor: args.cursor || null,
        itemsView: "full",
      }),
    ]);
    return {
      chat: simplifyThread(threadResult.thread || { id: threadId }),
      turns: (turnsResult.data || []).map((turn) =>
        simplifyTurn(turn, Boolean(args.includeTechnicalItems)),
      ),
      nextCursor: turnsResult.nextCursor || null,
    };
  }
  if (name === "codex_send_message_to_chat") {
    const threadId = String(args.threadId || "").trim();
    const message = String(args.message || "").trim();
    if (!threadId) throw new Error("threadId is required");
    if (!message) throw new Error("message is required");
    return sendMessageToChat(client, threadId, message);
  }
  throw new Error(`Unknown tool: ${name}`);
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function main() {
  const client = createBridgeClient();
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    Promise.resolve()
      .then(async () => {
        const message = JSON.parse(line);
        if (message.id === undefined) return;
        if (message.method === "initialize") {
          write({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: { listChanged: false } },
              serverInfo: SERVER_INFO,
            },
          });
          return;
        }
        if (message.method === "ping") {
          write({ jsonrpc: "2.0", id: message.id, result: {} });
          return;
        }
        if (message.method === "tools/list") {
          write({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
          return;
        }
        if (message.method === "tools/call") {
          try {
            const result = await callTool(
              client,
              message.params?.name,
              message.params?.arguments || {},
            );
            write({
              jsonrpc: "2.0",
              id: message.id,
              result: { content: [{ type: "text", text: JSON.stringify(result) }] },
            });
          } catch (error) {
            write({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                content: [{ type: "text", text: `Codex chat tool failed: ${error.message}` }],
                isError: true,
              },
            });
          }
          return;
        }
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        });
      })
      .catch((error) => {
        process.stderr.write(`${error.stack || error.message}\n`);
      });
  });
  input.on("close", () => client.stop());
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  TOOLS,
  boundedText,
  callTool,
  clampInteger,
  simplifyItem,
  simplifyThread,
  simplifyTurn,
  sendMessageToChat,
};
