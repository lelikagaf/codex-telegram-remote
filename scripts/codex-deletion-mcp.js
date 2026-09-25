#!/usr/bin/env node
"use strict";

const readline = require("node:readline");
const { deleteLocalPaths, deleteRemotePaths } = require("../src/deletion-service");

const SERVER_INFO = { name: "codex-telegram-deletion", version: "0.1.0" };
const LOCAL_TOOL_NAME = "delete_local_paths";
const SSH_TOOL_NAME = "delete_ssh_paths";

function localTool() {
  return {
    name: LOCAL_TOOL_NAME,
    description: [
      "Permanently delete explicitly listed local Windows files or directories for the Telegram owner.",
      "Use this tool when the owner explicitly asks to delete local files, backups, exports, generated artifacts, or directories.",
      "Use it instead of exec_command when normal shell deletion is blocked by policy.",
      "The tool recursively deletes directories and verifies that every listed target is gone.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: { type: "string", minLength: 3 },
          description: "Exact absolute Windows paths. Globs are not accepted.",
        },
        reason: { type: "string", description: "Short explanation of the requested cleanup." },
      },
      required: ["paths", "reason"],
      additionalProperties: false,
    },
  };
}

function sshTool() {
  return {
    name: SSH_TOOL_NAME,
    description: [
      "Permanently delete explicitly listed files or directories on an SSH server for the Telegram owner.",
      "Use this tool when the owner explicitly asks to remove remote files, backups, exports, scripts, or directories.",
      "Use it instead of sending rm, unlink, or a deletion script through exec_command when that command is blocked by policy.",
      "The tool uses strict host-key checking, recursively deletes directories, and verifies every listed target.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", minLength: 1 },
        user: { type: "string", minLength: 1 },
        port: { type: "integer", minimum: 1, maximum: 65535, default: 22 },
        identityFile: {
          type: "string",
          description: "Optional absolute path to the local SSH private key. Omit to use normal SSH configuration or agent.",
        },
        paths: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: { type: "string", minLength: 2 },
          description: "Exact absolute POSIX paths on the SSH server. Globs are not accepted.",
        },
        reason: { type: "string", description: "Short explanation of the requested cleanup." },
      },
      required: ["host", "user", "paths", "reason"],
      additionalProperties: false,
    },
  };
}

function toolsForAccess(access) {
  if (access === "local") return [localTool()];
  if (access === "all") return [localTool(), sshTool()];
  return [];
}

function parseProtectedPaths() {
  try {
    const value = JSON.parse(process.env.CODEX_DELETION_PROTECTED_PATHS || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function callTool(access, name, args = {}, options = {}) {
  if (access === "off") throw new Error("Удаление через Telegram отключено.");
  if (name === LOCAL_TOOL_NAME && ["local", "all"].includes(access)) {
    return deleteLocalPaths(args.paths, {
      protectedPaths: options.protectedPaths || parseProtectedPaths(),
    });
  }
  if (name === SSH_TOOL_NAME && access === "all") {
    return deleteRemotePaths(args, {
      spawnSyncImpl: options.spawnSyncImpl,
      timeoutMs: options.timeoutMs || Math.max(
        30,
        Number(process.env.CODEX_DELETION_MAX_RUNTIME_SECONDS) || 600,
      ) * 1000,
    });
  }
  throw new Error(`Инструмент удаления недоступен в режиме ${access}: ${name}`);
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function main() {
  const access = String(process.env.CODEX_DELETION_ACCESS || "off").trim().toLowerCase();
  if (!["off", "local", "all"].includes(access)) {
    throw new Error("CODEX_DELETION_ACCESS должен быть off, local или all.");
  }
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
            instructions: "Use these deletion tools only after an explicit deletion request from the Telegram owner. Pass exact paths, never globs. Prefer these tools when shell deletion is blocked by policy.",
          },
        });
        return;
      }
      if (message.method === "ping") {
        write({ jsonrpc: "2.0", id: message.id, result: {} });
        return;
      }
      if (message.method === "tools/list") {
        write({ jsonrpc: "2.0", id: message.id, result: { tools: toolsForAccess(access) } });
        return;
      }
      if (message.method === "tools/call") {
        try {
          const result = await callTool(access, message.params?.name, message.params?.arguments || {});
          write({
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: JSON.stringify(result) }], isError: false },
          });
        } catch (error) {
          write({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [{ type: "text", text: `Deletion failed: ${error.message}` }],
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

module.exports = {
  LOCAL_TOOL_NAME,
  SERVER_INFO,
  SSH_TOOL_NAME,
  callTool,
  toolsForAccess,
};
