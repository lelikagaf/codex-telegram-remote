const path = require("node:path");

const TELEGRAM_TEXT_LIMIT = 4096;

function splitText(text, maxLength = 3900) {
  const source = String(text || "").trim() || "(пустой ответ)";
  const chunks = [];
  let rest = source;

  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf("\n", maxLength);
    if (cut < Math.floor(maxLength * 0.6)) cut = rest.lastIndexOf(" ", maxLength);
    if (cut < Math.floor(maxLength * 0.6)) cut = maxLength;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function shortPath(value, maxLength = 90) {
  if (!value || value.length <= maxLength) return value || "—";
  const base = path.basename(value);
  const keep = Math.max(10, maxLength - base.length - 5);
  return `${value.slice(0, keep)}…\\${base}`;
}

function threadTitle(thread) {
  const title = thread.name || thread.preview || "Без названия";
  return String(title).replace(/\s+/g, " ").trim().slice(0, 80);
}

function formatThreadList(threads, currentThreadId) {
  if (!threads.length) return "Чаты Codex не найдены.";
  const lines = ["Последние чаты Codex:", ""];
  threads.forEach((thread, index) => {
    const selected = thread.id === currentThreadId ? "●" : "○";
    lines.push(`${selected} ${index + 1}. ${threadTitle(thread)}`);
    lines.push(`   ${shortPath(thread.cwd)}`);
  });
  lines.push("", "Переключение: /use 2 или кнопкой ниже.");
  return lines.join("\n");
}

function formatThread(thread, selected = true) {
  return [
    selected ? "Текущий чат:" : "Чат:",
    threadTitle(thread),
    `ID: ${thread.id}`,
    `Папка: ${thread.cwd || "—"}`,
    `Статус: ${thread.status?.type || "неизвестен"}`,
  ].join("\n");
}

module.exports = {
  TELEGRAM_TEXT_LIMIT,
  formatThread,
  formatThreadList,
  shortPath,
  splitText,
  threadTitle,
};
