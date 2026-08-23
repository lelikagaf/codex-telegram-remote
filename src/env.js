const fs = require("node:fs");
const path = require("node:path");

function parseEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator < 1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const values = parseEnv(fs.readFileSync(filePath, "utf8"));
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function parseApprovalPolicy(value) {
  const policy = (value || "never").trim().toLowerCase();
  if (["never", "on-request", "untrusted"].includes(policy)) return policy;

  const error = new Error(
    "CODEX_APPROVAL_POLICY должен быть never, on-request или untrusted.",
  );
  error.exitCode = 78;
  throw error;
}

function parseFileSizeLimitMb(value, fallback = 0) {
  const raw = value === undefined || String(value).trim() === "" ? fallback : Number(value);
  if (!Number.isFinite(raw) || raw < -1 || (raw < 0 && raw !== -1)) {
    const error = new Error(
      "TELEGRAM_MAX_FILE_SIZE_MB должен быть положительным числом, 0 или -1.",
    );
    error.exitCode = 78;
    throw error;
  }
  if (raw === 0 || raw === -1) return 0;

  const bytes = Math.floor(raw * 1024 * 1024);
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    const error = new Error("TELEGRAM_MAX_FILE_SIZE_MB выходит за допустимый диапазон.");
    error.exitCode = 78;
    throw error;
  }
  return bytes;
}

function loadConfig(projectRoot) {
  loadEnvFile(path.join(projectRoot, ".env"));

  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const allowedRaw = (process.env.TELEGRAM_ALLOWED_USER_ID || "").trim();
  const allowedUserId = allowedRaw ? Number(allowedRaw) : null;

  if (!token) {
    const error = new Error(
      "TELEGRAM_BOT_TOKEN не задан. Скопируйте .env.example в .env и добавьте новый токен.",
    );
    error.exitCode = 78;
    throw error;
  }
  if (allowedRaw && (!Number.isSafeInteger(allowedUserId) || allowedUserId <= 0)) {
    const error = new Error("TELEGRAM_ALLOWED_USER_ID должен быть положительным числом.");
    error.exitCode = 78;
    throw error;
  }

  const defaultCwd =
    (process.env.CODEX_DEFAULT_CWD || "").trim() ||
    path.join(process.env.USERPROFILE || projectRoot, "Documents", "Codex");

  return {
    projectRoot,
    token,
    allowedUserId,
    codexBinary: (process.env.CODEX_BINARY || "").trim() || null,
    codexApprovalPolicy: parseApprovalPolicy(process.env.CODEX_APPROVAL_POLICY),
    defaultCwd,
    notifyOnStart: parseBoolean(process.env.TELEGRAM_NOTIFY_ON_START, true),
    notifyAfterSleep: parseBoolean(process.env.TELEGRAM_NOTIFY_AFTER_SLEEP, false),
    telegramMaxFileBytes: parseFileSizeLimitMb(process.env.TELEGRAM_MAX_FILE_SIZE_MB, 0),
    resumeGapMs:
      Math.max(30, Number(process.env.RESUME_NOTIFICATION_GAP_SECONDS) || 120) * 1000,
    desktopSyncPollMs:
      Math.max(2, Number(process.env.DESKTOP_SYNC_POLL_SECONDS) || 3) * 1000,
    writerIdleMs:
      Math.max(5, Number(process.env.CODEX_WRITER_IDLE_SECONDS) || 90) * 1000,
    logLevel: (process.env.LOG_LEVEL || "info").toLowerCase(),
    statePath: path.join(projectRoot, "data", "state.json"),
    logPath: path.join(projectRoot, "logs", "bot.log"),
    releaseLogPath: path.join(projectRoot, "data", "releases.jsonl"),
  };
}

module.exports = {
  loadConfig,
  loadEnvFile,
  parseApprovalPolicy,
  parseBoolean,
  parseEnv,
  parseFileSizeLimitMb,
};
