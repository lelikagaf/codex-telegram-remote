"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REQUEST_ID_PATTERN = /^[a-f0-9]{32}$/;

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function writeJsonAtomic(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function requestDigest(request) {
  return crypto
    .createHash("sha256")
    .update([
      request.id,
      request.threadId,
      request.cwd,
      request.command,
      request.reason,
      request.createdAt,
      request.expiresAt,
      request.maxRuntimeSeconds,
    ].map((value) => String(value || "")).join("\n"), "utf8")
    .digest("hex");
}

function validateRequest(request) {
  if (!REQUEST_ID_PATTERN.test(String(request?.id || ""))) {
    throw new Error("Некорректный ID запроса повышения прав.");
  }
  if (!String(request?.threadId || "").trim()) {
    throw new Error("В запросе повышения прав отсутствует threadId.");
  }
  if (!String(request?.command || "").trim()) {
    throw new Error("В запросе повышения прав отсутствует команда.");
  }
  const cwd = String(request?.cwd || "").trim();
  if (!path.isAbsolute(cwd)) {
    throw new Error("Рабочая папка повышенной команды должна быть абсолютной.");
  }
  if (request.digest !== requestDigest(request)) {
    throw new Error("Контрольная сумма запроса повышения прав не совпадает.");
  }
  return request;
}

class ElevationQueue {
  constructor({
    spoolPath,
    taskName,
    timeoutMs = 300_000,
    maxRuntimeSeconds = 600,
    logger = null,
  }) {
    this.spoolPath = path.resolve(spoolPath);
    this.taskName = taskName;
    this.timeoutMs = timeoutMs;
    this.maxRuntimeSeconds = Math.max(30, Number(maxRuntimeSeconds) || 600);
    this.logger = logger;
    this.requestsPath = path.join(this.spoolPath, "requests");
    this.approvedPath = path.join(this.spoolPath, "approved");
    this.resultsPath = path.join(this.spoolPath, "results");
    for (const directory of [this.requestsPath, this.approvedPath, this.resultsPath]) {
      ensureDirectory(directory);
    }
  }

  #path(directory, id) {
    if (!REQUEST_ID_PATTERN.test(String(id || ""))) throw new Error("Некорректный ID запроса.");
    return path.join(directory, `${id}.json`);
  }

  createRequest({ threadId, command, cwd, reason = "" }) {
    const id = crypto.randomUUID().replace(/-/g, "");
    const createdAt = new Date();
    const request = {
      id,
      threadId: String(threadId || "").trim(),
      command: String(command || "").trim(),
      cwd: path.resolve(String(cwd || "")),
      reason: String(reason || "").trim(),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.timeoutMs).toISOString(),
      maxRuntimeSeconds: this.maxRuntimeSeconds,
    };
    request.digest = requestDigest(request);
    validateRequest(request);
    writeJsonAtomic(this.#path(this.requestsPath, id), request);
    return request;
  }

  readRequest(id) {
    return validateRequest(readJson(this.#path(this.requestsPath, id)));
  }

  listPendingRequests() {
    const requests = [];
    for (const name of fs.readdirSync(this.requestsPath)) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (!REQUEST_ID_PATTERN.test(id)) continue;
      if (fs.existsSync(this.#path(this.resultsPath, id))) continue;
      try {
        requests.push(this.readRequest(id));
      } catch (error) {
        this.logger?.warn?.("Некорректный запрос повышения прав", { id, message: error.message });
      }
    }
    return requests.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  }

  hasResult(id) {
    return fs.existsSync(this.#path(this.resultsPath, id));
  }

  readResult(id) {
    return readJson(this.#path(this.resultsPath, id));
  }

  approve(id) {
    const request = this.readRequest(id);
    if (Date.parse(request.expiresAt) <= Date.now()) {
      this.finish(id, { status: "expired", message: "Срок подтверждения истёк." });
      throw new Error("Срок подтверждения истёк.");
    }
    const approved = {
      ...request,
      approvedAt: new Date().toISOString(),
    };
    writeJsonAtomic(this.#path(this.approvedPath, id), approved);
    return approved;
  }

  deny(id, message = "Владелец отклонил выполнение команды.") {
    return this.finish(id, { status: "denied", message });
  }

  finish(id, result) {
    const payload = {
      id,
      ...result,
      completedAt: new Date().toISOString(),
    };
    writeJsonAtomic(this.#path(this.resultsPath, id), payload);
    fs.rmSync(this.#path(this.approvedPath, id), { force: true });
    return payload;
  }

  triggerHelper() {
    const result = spawnSync(
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "schtasks.exe"),
      ["/Run", "/TN", this.taskName],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(String(result.stderr || result.stdout || `schtasks exit ${result.status}`).trim());
    }
    return true;
  }

  async waitForResult(id, { pollMs = 250, timeoutMs = this.timeoutMs + 30_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.hasResult(id)) return this.readResult(id);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return this.finish(id, { status: "expired", message: "Истекло время ожидания подтверждения." });
  }
}

module.exports = {
  ElevationQueue,
  REQUEST_ID_PATTERN,
  readJson,
  requestDigest,
  validateRequest,
  writeJsonAtomic,
};
