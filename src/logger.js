const fs = require("node:fs");
const path = require("node:path");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function redact(value) {
  return String(value)
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TELEGRAM_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]");
}

function createLogger(level = "info", filePath = null) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  if (filePath) fs.mkdirSync(path.dirname(filePath), { recursive: true });

  function write(name, message, details) {
    if (LEVELS[name] < threshold) return;
    const suffix =
      details === undefined
        ? ""
        : ` ${redact(typeof details === "string" ? details : JSON.stringify(details))}`;
    const line = `${new Date().toISOString()} ${name.toUpperCase()} ${redact(message)}${suffix}`;
    const stream = name === "error" ? process.stderr : process.stdout;
    stream.write(`${line}\n`);
    if (filePath) fs.appendFileSync(filePath, `${line}\n`, "utf8");
  }

  return {
    debug: (message, details) => write("debug", message, details),
    info: (message, details) => write("info", message, details),
    warn: (message, details) => write("warn", message, details),
    error: (message, details) => write("error", message, details),
  };
}

module.exports = { createLogger, redact };
