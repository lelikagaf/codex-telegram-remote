const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const readline = require("node:readline");

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
  constructor({ launch, cwd, approvalPolicy = "never", logger }) {
    super();
    this.launch = launch;
    this.cwd = cwd;
    this.approvalPolicy = approvalPolicy;
    this.logger = logger;
    this.child = null;
    this.lineReader = null;
    this.pending = new Map();
    this.nextId = 1;
    this.startPromise = null;
    this.loadedThreads = new Set();
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
    });
    this.loadedThreads.clear();
    this.child = spawn(
      this.launch.command,
      [
        ...this.launch.argsPrefix,
        "--ask-for-approval",
        this.approvalPolicy,
        "app-server",
        "--stdio",
      ],
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

  async listThreads({ limit = 10, cursor = null } = {}) {
    const params = {
      cursor,
      limit,
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

  listTurns(threadId, { limit = 50, itemsView = "full" } = {}) {
    return this.request("thread/turns/list", {
      threadId,
      limit,
      sortDirection: "desc",
      itemsView,
    });
  }

  async resumeThread(threadId) {
    if (this.loadedThreads.has(threadId)) return;
    await this.request("thread/resume", { threadId }, 120000);
    this.loadedThreads.add(threadId);
  }

  async startThread({ cwd, name = null }) {
    const result = await this.request(
      "thread/start",
      { cwd, serviceName: "codex_telegram_remote" },
      120000,
    );
    const threadId = result.thread.id;
    this.loadedThreads.add(threadId);
    if (name) {
      await this.request("thread/name/set", { threadId, name });
      result.thread.name = name;
    }
    return result;
  }

  startTurn(threadId, text) {
    return this.request(
      "turn/start",
      { threadId, input: [{ type: "text", text }] },
      120000,
    );
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
    if (child && !child.killed) child.kill();
  }
}

module.exports = { CodexClient, CodexRpcError };
