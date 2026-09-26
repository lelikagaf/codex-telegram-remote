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

function parseActiveWriterMode(value) {
  const mode = String(value || "queue").trim().toLowerCase();
  if (["queue", "fork", "ask"].includes(mode)) return mode;
  const error = new Error("CODEX_ACTIVE_WRITER_MODE должен быть queue, fork или ask.");
  error.exitCode = 78;
  throw error;
}

function parseElevationMode(value) {
  const mode = String(value || "off").trim().toLowerCase();
  if (["off", "ask", "always"].includes(mode)) return mode;
  const error = new Error("CODEX_ELEVATION_MODE должен быть off, ask или always.");
  error.exitCode = 78;
  throw error;
}

function parseDeletionAccess(value) {
  const mode = String(value || "off").trim().toLowerCase();
  if (["off", "local", "all"].includes(mode)) return mode;
  const error = new Error("CODEX_DELETION_ACCESS должен быть off, local или all.");
  error.exitCode = 78;
  throw error;
}

function parseOutgoingFileAccess(value) {
  const mode = String(value || "workspace").trim().toLowerCase();
  if (["off", "workspace", "all"].includes(mode)) return mode;
  const error = new Error(
    "TELEGRAM_OUTGOING_FILE_ACCESS должен быть off, workspace или all.",
  );
  error.exitCode = 78;
  throw error;
}

function parseFileSizeLimitMb(value, fallback = 0, variableName = "TELEGRAM_MAX_FILE_SIZE_MB") {
  const raw = value === undefined || String(value).trim() === "" ? fallback : Number(value);
  if (!Number.isFinite(raw) || raw < -1 || (raw < 0 && raw !== -1)) {
    const error = new Error(
      `${variableName} должен быть положительным числом, 0 или -1.`,
    );
    error.exitCode = 78;
    throw error;
  }
  if (raw === 0 || raw === -1) return 0;

  const bytes = Math.floor(raw * 1024 * 1024);
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    const error = new Error(`${variableName} выходит за допустимый диапазон.`);
    error.exitCode = 78;
    throw error;
  }
  return bytes;
}

function parseNonNegativeInteger(value, fallback, variableName) {
  const raw = value === undefined || String(value).trim() === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(raw) || raw < 0) {
    const error = new Error(`${variableName} должен быть целым неотрицательным числом.`);
    error.exitCode = 78;
    throw error;
  }
  return raw;
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
    codexFullAccess: parseBoolean(process.env.CODEX_FULL_ACCESS, false),
    codexAppToolsEnabled: parseBoolean(process.env.CODEX_APP_TOOLS_ENABLED, false),
    activeWriterMode: parseActiveWriterMode(process.env.CODEX_ACTIVE_WRITER_MODE),
    elevationMode: parseElevationMode(process.env.CODEX_ELEVATION_MODE),
    elevationTaskName:
      (process.env.CODEX_ELEVATION_TASK_NAME || "").trim() ||
      "Codex Telegram Elevated Helper",
    elevationTimeoutMs:
      Math.max(30, Number(process.env.CODEX_ELEVATION_TIMEOUT_SECONDS) || 300) * 1000,
    elevationMaxRuntimeSeconds:
      Math.max(30, Number(process.env.CODEX_ELEVATION_MAX_RUNTIME_SECONDS) || 600),
    elevationSpoolPath:
      (process.env.CODEX_ELEVATION_SPOOL_PATH || "").trim() ||
      path.join(process.env.LOCALAPPDATA || projectRoot, "CodexTelegramRemote", "elevation"),
    deletionAccess: parseDeletionAccess(process.env.CODEX_DELETION_ACCESS),
    deletionMaxRuntimeSeconds:
      Math.max(30, Number(process.env.CODEX_DELETION_MAX_RUNTIME_SECONDS) || 600),
    defaultCwd,
    notifyOnStart: parseBoolean(process.env.TELEGRAM_NOTIFY_ON_START, true),
    notifyAfterSleep: parseBoolean(process.env.TELEGRAM_NOTIFY_AFTER_SLEEP, false),
    telegramMaxFileBytes: parseFileSizeLimitMb(process.env.TELEGRAM_MAX_FILE_SIZE_MB, 0),
    telegramPhotoEnabled: parseBoolean(process.env.TELEGRAM_PHOTO_ENABLED, false),
    telegramVideoEnabled: parseBoolean(process.env.TELEGRAM_VIDEO_ENABLED, false),
    telegramPhotoMaxFileBytes: parseFileSizeLimitMb(
      process.env.TELEGRAM_PHOTO_MAX_FILE_SIZE_MB,
      20,
      "TELEGRAM_PHOTO_MAX_FILE_SIZE_MB",
    ),
    telegramVideoMaxFileBytes: parseFileSizeLimitMb(
      process.env.TELEGRAM_VIDEO_MAX_FILE_SIZE_MB,
      20,
      "TELEGRAM_VIDEO_MAX_FILE_SIZE_MB",
    ),
    telegramOutgoingFileAccess: parseOutgoingFileAccess(
      process.env.TELEGRAM_OUTGOING_FILE_ACCESS,
    ),
    telegramOutgoingMaxFileBytes: parseFileSizeLimitMb(
      process.env.TELEGRAM_OUTGOING_MAX_FILE_SIZE_MB,
      50,
      "TELEGRAM_OUTGOING_MAX_FILE_SIZE_MB",
    ),
    telegramOutgoingMaxFiles: parseNonNegativeInteger(
      process.env.TELEGRAM_OUTGOING_MAX_FILES,
      10,
      "TELEGRAM_OUTGOING_MAX_FILES",
    ),
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
  parseActiveWriterMode,
  parseBoolean,
  parseDeletionAccess,
  parseElevationMode,
  parseEnv,
  parseFileSizeLimitMb,
  parseNonNegativeInteger,
  parseOutgoingFileAccess,
};
