#!/usr/bin/env node
"use strict";

const readline = require("node:readline");
const { ElevationQueue } = require("../src/elevation-queue");

const SERVER_INFO = { name: "codex-telegram-elevation", version: "0.1.0" };
const TOOL_NAME = "run_windows_command_as_administrator";
const TOOLS = [{
  name: TOOL_NAME,
  description: [
    "Run a Windows PowerShell command with administrator privileges after approval in Telegram.",
    "Use this tool whenever the user asks for a UAC/admin/elevated operation or an ordinary command reports that administrator privileges are required.",
    "Do not use Start-Process -Verb RunAs and do not ask the user to click a local UAC dialog when this tool is available.",
    "The call waits for the Telegram owner to approve or cancel and then returns stdout, stderr, and the exit code.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      threadId: {
        type: "string",
        minLength: 1,
        description: "Current Codex thread ID from the codex-telegram-remote application context.",
      },
      command: {
        type: "string",
        minLength: 1,
        description: "Exact PowerShell command or script to run as administrator.",
      },
      cwd: {
        type: "string",
        minLength: 3,
        description: "Absolute Windows working directory for the command.",
      },
      reason: {
        type: "string",
        description: "Short user-facing explanation of why administrator privileges are required.",
      },
    },
    required: ["threadId", "command", "cwd", "reason"],
    additionalProperties: false,
  },
}];

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function resultText(result) {
  if (result.status === "completed") {
    return JSON.stringify({
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      timedOut: Boolean(result.timedOut),
    });
  }
  return JSON.stringify({
    status: result.status || "failed",
    message: result.message || "Повышенная команда не выполнена.",
  });
}

async function callTool(queue, name, args = {}) {
  if (name !== TOOL_NAME) throw new Error(`Unknown tool: ${name}`);
  const request = queue.createRequest({
    threadId: args.threadId,
    command: args.command,
    cwd: args.cwd,
    reason: args.reason,
  });
  const result = await queue.waitForResult(request.id);
  return {
    content: [{ type: "text", text: resultText(result) }],
    isError: result.status !== "completed" || Number(result.exitCode) !== 0,
  };
}

async function main() {
  const spoolPath = process.env.CODEX_ELEVATION_SPOOL_PATH;
  if (!spoolPath) throw new Error("CODEX_ELEVATION_SPOOL_PATH is not configured");
  const queue = new ElevationQueue({
    spoolPath,
    taskName: process.env.CODEX_ELEVATION_TASK_NAME || "Codex Telegram Elevated Helper",
    timeoutMs: Math.max(30, Number(process.env.CODEX_ELEVATION_TIMEOUT_SECONDS) || 300) * 1000,
    maxRuntimeSeconds: Math.max(
      30,
      Number(process.env.CODEX_ELEVATION_MAX_RUNTIME_SECONDS) || 600,
    ),
  });
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    Promise.resolve().then(async () => {
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
          const result = await callTool(queue, message.params?.name, message.params?.arguments || {});
          write({ jsonrpc: "2.0", id: message.id, result });
        } catch (error) {
          write({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [{ type: "text", text: `Elevated command failed: ${error.message}` }],
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
    }).catch((error) => process.stderr.write(`${error.stack || error.message}\n`));
  });
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { SERVER_INFO, TOOL_NAME, TOOLS, callTool, resultText };
