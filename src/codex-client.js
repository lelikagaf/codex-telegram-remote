const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");

const CHAT_TOOLS_SERVER_NAME = "codex_telegram_chats";

function buildChatToolsOverrides({ enabled, launch, cwd, fullAccess = false }) {
  if (!enabled) return {};
  const serverPath = path.resolve(__dirname, "..", "scripts", "codex-chat-mcp.js");
  return {
    config: {
      mcp_servers: {
        [CHAT_TOOLS_SERVER_NAME]: {
          command: process.execPath,
          args: [serverPath],
          env: {
            CODEX_CHAT_BRIDGE_COMMAND: launch.command,
            CODEX_CHAT_BRIDGE_ARGS: JSON.stringify(launch.argsPrefix || []),
            CODEX_CHAT_BRIDGE_CWD: cwd,
            CODEX_CHAT_BRIDGE_FULL_ACCESS: fullAccess ? "true" : "false",
          },
          startup_timeout_sec: 30,
          tool_timeout_sec: 120,
        },
      },
    },
  };
}

function buildCodexAppServerArgs({
  argsPrefix = [],
  approvalPolicy = "never",
  fullAccess = false,
  cwd,
}) {
  const args = [...argsPrefix];
  if (fullAccess) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--ask-for-approval", approvalPolicy);
  }
  if (cwd) {
    args.push("--add-dir", cwd);
  }
  args.push("app-server", "--stdio");
  return args;
}

class CodexRpcError extends Error {
  constructor(method, rpcError) {
    super(`${method}: ${rpcError?.message || "ошибка Codex app-server"}`);
    this.name = "CodexRpcError";
    this.method = method;
    this.code = rpcError?.code;
    this.data = rpcError?.data;
  }
}

class CodexClient extends EventEmitter {
  constructor({
    launch,
    cwd,
    approvalPolicy = "never",
    fullAccess = false,
    appToolsEnabled = false,
    logger,
  }) {
    super();
    this.launch = launch;
    this.cwd = cwd;
    this.approvalPolicy = approvalPolicy;
    this.fullAccess = fullAccess;
    this.appToolsEnabled = appToolsEnabled;
    this.logger = logger;
    this.child = null;
    this.lineReader = null;
    this.pending = new Map();
    this.nextId = 1;
    this.startPromise = null;
    this.loadedThreads = new Set();
    this.threadModelSettings = new Map();
  }

  get isRunning() {
    return Boolean(this.child && !this.child.killed && this.child.exitCode === null);
  }

  async ensureStarted() {
    if (this.isRunning) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#start().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async #start() {
    this.logger.info("Запуск Codex app-server", {
      version: this.launch.version.raw,
      cwd: this.cwd,
      approvalPolicy: this.fullAccess ? "never" : this.approvalPolicy,
      fullAccess: this.fullAccess,
      appToolsEnabled: this.appToolsEnabled,
    });
    this.loadedThreads.clear();
    this.child = spawn(
      this.launch.command,
      buildCodexAppServerArgs({
        argsPrefix: this.launch.argsPrefix,
        approvalPolicy: this.approvalPolicy,
        fullAccess: this.fullAccess,
        cwd: this.cwd,
      }),
      {
        cwd: this.cwd,
        env: process.env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    this.child.on("error", (error) => this.#handleExit(error));
    this.child.on("exit", (code, signal) => {
      this.#handleExit(new Error(`Codex app-server завершён: code=${code}, signal=${signal}`));
    });
    this.child.stderr.on("data", (chunk) => {
      const line = String(chunk).trim();
      if (line) this.logger.debug("Codex stderr", line.slice(0, 2000));
    });

    this.lineReader = readline.createInterface({ input: this.child.stdout });
    this.lineReader.on("line", (line) => this.#handleLine(line));

    await this.request(
      "initialize",
      {
        clientInfo: {
          name: "codex_telegram_remote",
          title: "Codex Telegram Remote",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
      20000,
      { skipEnsure: true },
    );
    this.notify("initialized", {});
    this.emit("ready");
  }

  #handleExit(error) {
    if (!this.child && !this.pending.size) return;
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.loadedThreads.clear();
    this.threadModelSettings.clear();
    this.child = null;
    for (const item of pending) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.emit("disconnected", error);
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.logger.warn("Некорректная строка от Codex app-server", line.slice(0, 500));
      return;
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new CodexRpcError(pending.method, message.error));
      else pending.resolve(message.result);
      return;
    }

    if (message.method && message.id !== undefined) {
      this.emit("serverRequest", message);
      return;
    }

    if (message.method === "thread/settings/updated") {
      const threadId = message.params?.threadId;
      const settings = message.params?.threadSettings;
      if (threadId && settings) {
        this.threadModelSettings.set(threadId, {
          model: settings.model,
          reasoningEffort: settings.effort ?? null,
        });
      }
    }

    if (message.method) this.emit("notification", message);
  }

  #write(message) {
    if (!this.isRunning || !this.child.stdin.writable) {
      throw new Error("Codex app-server не запущен");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async request(method, params = {}, timeoutMs = 60000, options = {}) {
    if (!options.skipEnsure) await this.ensureStarted();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Тайм-аут Codex RPC: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.#write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.#write({ method, params });
  }

  respond(id, result) {
    this.#write({ id, result });
  }

  respondError(id, code, message) {
    this.#write({ id, error: { code, message } });
  }

  async listThreads({ limit = 10, cursor = null, searchTerm = null, archived = false } = {}) {
    const params = {
      cursor,
      limit,
      searchTerm,
      archived,
      sortKey: "recency_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
    };
    try {
      return await this.request("thread/list", params);
    } catch (error) {
      if (!(error instanceof CodexRpcError)) throw error;
      return this.request("thread/list", { ...params, sortKey: "updated_at" });
    }
  }

  readThread(threadId, includeTurns = false) {
    return this.request("thread/read", { threadId, includeTurns });
  }

  async listTurns(threadId, { limit = 50, cursor = null, itemsView = "full" } = {}) {
    const localOffset = /^local:(\d+)$/.exec(String(cursor || ""));
    if (!localOffset) {
      try {
        return await this.request("thread/turns/list", {
          threadId,
          limit,
          cursor,
          sortDirection: "desc",
          itemsView,
        });
      } catch (error) {
        if (!/thread not loaded/i.test(String(error?.message || error))) throw error;
      }
    }

    // thread/read can inspect persisted history without acquiring the thread writer.
    const result = await this.readThread(threadId, true);
    const turns = Array.isArray(result.thread?.turns) ? [...result.thread.turns] : [];
    turns.sort((left, right) => {
      const leftTime = left.completedAt || left.startedAt || 0;
      const rightTime = right.completedAt || right.startedAt || 0;
      return rightTime - leftTime || String(right.id || "").localeCompare(String(left.id || ""));
    });
    const offset = localOffset ? Number(localOffset[1]) : 0;
    const data = turns.slice(offset, offset + limit);
    const nextOffset = offset + data.length;
    return {
      data,
      nextCursor: nextOffset < turns.length ? `local:${nextOffset}` : null,
    };
  }

  async resumeThread(threadId) {
    if (this.loadedThreads.has(threadId)) {
      return this.threadModelSettings.get(threadId) || null;
    }
    const accessOverrides = this.fullAccess
      ? { approvalPolicy: "never", sandbox: "danger-full-access" }
      : {};
    const appToolsOverrides = buildChatToolsOverrides({
      enabled: this.appToolsEnabled,
      launch: this.launch,
      cwd: this.cwd,
      fullAccess: this.fullAccess,
    });
    const result = await this.request(
      "thread/resume",
      { threadId, ...accessOverrides, ...appToolsOverrides },
      120000,
    );
    this.loadedThreads.add(threadId);
    const settings = {
      model: result.model,
      reasoningEffort: result.reasoningEffort ?? null,
    };
    this.threadModelSettings.set(threadId, settings);
    return settings;
  }

  async startThread({ cwd, name = null }) {
    const accessOverrides = this.fullAccess
      ? { approvalPolicy: "never", sandbox: "danger-full-access" }
      : {};
    const appToolsOverrides = buildChatToolsOverrides({
      enabled: this.appToolsEnabled,
      launch: this.launch,
      cwd: this.cwd,
      fullAccess: this.fullAccess,
    });
    const result = await this.request(
      "thread/start",
      {
        cwd,
        serviceName: "codex_telegram_remote",
        ...accessOverrides,
        ...appToolsOverrides,
      },
      120000,
    );
    const threadId = result.thread.id;
    this.loadedThreads.add(threadId);
    this.threadModelSettings.set(threadId, {
      model: result.model,
      reasoningEffort: result.reasoningEffort ?? null,
    });
    if (name) {
      await this.request("thread/name/set", { threadId, name });
      result.thread.name = name;
    }
    return result;
  }

  async forkThread(threadId, { name = null } = {}) {
    const accessOverrides = this.fullAccess
      ? { approvalPolicy: "never", sandbox: "danger-full-access" }
      : {};
    const appToolsOverrides = buildChatToolsOverrides({
      enabled: this.appToolsEnabled,
      launch: this.launch,
      cwd: this.cwd,
      fullAccess: this.fullAccess,
    });
    const result = await this.request(
      "thread/fork",
      {
        threadId,
        ...accessOverrides,
        ...appToolsOverrides,
      },
      120000,
    );
    const forkedThreadId = result.thread.id;
    this.loadedThreads.add(forkedThreadId);
    this.threadModelSettings.set(forkedThreadId, {
      model: result.model,
      reasoningEffort: result.reasoningEffort ?? null,
    });
    if (name) {
      await this.request("thread/name/set", { threadId: forkedThreadId, name });
      result.thread.name = name;
    }
    return result;
  }

  listModels({ includeHidden = false } = {}) {
    return this.request("model/list", { includeHidden });
  }

  async getThreadModelSettings(threadId) {
    const settings = await this.resumeThread(threadId);
    if (!settings) throw new Error("Codex не вернул настройки модели выбранного чата.");
    return { ...settings };
  }

  async updateThreadModelSettings(threadId, { model, reasoningEffort } = {}) {
    const current = await this.getThreadModelSettings(threadId);
    const params = { threadId };
    if (model !== undefined) params.model = model;
    if (reasoningEffort !== undefined) params.effort = reasoningEffort;
    await this.request("thread/settings/update", params);

    const settings = {
      model: model === undefined ? current.model : model,
      reasoningEffort:
        reasoningEffort === undefined ? current.reasoningEffort : reasoningEffort,
    };
    this.threadModelSettings.set(threadId, settings);
    return { ...settings };
  }

  startTurn(threadId, text) {
    const accessOverrides = this.fullAccess
      ? {
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        }
      : {};
    const appContext = this.appToolsEnabled
      ? {
          additionalContext: {
            "codex-telegram-remote": {
              kind: "application",
              value: [
                `Current Codex thread ID: ${threadId}`,
                "The codex_telegram_chats tools can list, read, and send messages to other Codex chats.",
                "When the user asks about another chat or asks to send something there, use those tools before claiming the action is unavailable.",
              ].join("\n"),
            },
          },
        }
      : {};
    return this.request(
      "turn/start",
      {
        threadId,
        input: [{ type: "text", text }],
        ...accessOverrides,
        ...appContext,
      },
      120000,
    );
  }

  async unsubscribeThread(threadId) {
    if (!this.isRunning) {
      this.loadedThreads.delete(threadId);
      this.threadModelSettings.delete(threadId);
      return { status: "notLoaded" };
    }
    try {
      return await this.request("thread/unsubscribe", { threadId });
    } finally {
      this.loadedThreads.delete(threadId);
      this.threadModelSettings.delete(threadId);
    }
  }

  get loadedThreadCount() {
    return this.loadedThreads.size;
  }

  steerTurn(threadId, turnId, text) {
    return this.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text }],
    });
  }

  interruptTurn(threadId, turnId) {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.loadedThreads.clear();
    this.threadModelSettings.clear();
    if (child && !child.killed) child.kill();
  }
}

module.exports = {
  CHAT_TOOLS_SERVER_NAME,
  CodexClient,
  CodexRpcError,
  buildChatToolsOverrides,
  buildCodexAppServerArgs,
};
