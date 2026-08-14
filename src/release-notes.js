const fs = require("node:fs");
const path = require("node:path");
const { CURRENT_RELEASE, RELEASE_HISTORY } = require("./app-release");

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function releaseTitle(kind) {
  switch (kind) {
    case "first-start":
      return "Первый запуск";
    case "restart":
      return "Перезапуск";
    case "update":
      return "Новая версия";
    case "rollback":
      return "Старая версия / откат";
    default:
      return "Другая версия";
  }
}

function releaseById(id, history = RELEASE_HISTORY) {
  return history.find((release) => release.id === id) || null;
}

function compareRelease(previous, current, history = RELEASE_HISTORY) {
  if (!previous) return "first-start";
  if (previous.releaseId === current.id) return "restart";

  const previousRelease = releaseById(previous.releaseId, history);
  if (!previousRelease) return "changed";
  if (previousRelease.sequence < current.sequence) return "update";
  if (previousRelease.sequence > current.sequence) return "rollback";
  return "changed";
}

function releasesBetween(previous, current, history = RELEASE_HISTORY) {
  if (!previous) return [current];
  const previousRelease = releaseById(previous.releaseId, history);
  if (!previousRelease) return [current];
  if (previousRelease.sequence < current.sequence) {
    return history.filter(
      (release) => release.sequence > previousRelease.sequence && release.sequence <= current.sequence,
    );
  }
  if (previousRelease.sequence > current.sequence) return [current];
  return [];
}

function createReleaseEntry({
  currentRelease = CURRENT_RELEASE,
  releaseHistory = RELEASE_HISTORY,
  codexVersion,
  previous = null,
  now = new Date(),
}) {
  const kind = compareRelease(previous, currentRelease, releaseHistory);
  const includedReleases = kind === "restart" ? [] : releasesBetween(previous, currentRelease, releaseHistory);
  return {
    startedAt: now.toISOString(),
    kind,
    releaseId: currentRelease.id,
    version: currentRelease.version,
    sequence: currentRelease.sequence,
    title: currentRelease.title,
    codexVersion: String(codexVersion || ""),
    notes: includedReleases.flatMap((release) =>
      release.notes.map((note) => ({ releaseId: release.id, version: release.version, text: note })),
    ),
    includedReleaseIds: includedReleases.map((release) => release.id),
  };
}

function recordReleaseStart({ logPath, codexVersion, currentRelease = CURRENT_RELEASE, now = new Date() }) {
  const entries = readJsonLines(logPath);
  const previous = entries.at(-1) || null;
  const entry = createReleaseEntry({ currentRelease, codexVersion, previous, now });
  appendJsonLine(logPath, entry);
  return { entry, previous, entries: [...entries, entry] };
}

function formatReleaseEntry(entry, { includeNotes = true } = {}) {
  if (!entry) return "Release notes пока нет.";
  const lines = [
    `${releaseTitle(entry.kind)}: ${entry.startedAt}`,
    `Версия бота: ${entry.version}`,
    `Release: ${entry.releaseId}`,
    `Codex: ${entry.codexVersion || "unknown"}`,
  ];
  if (includeNotes && Array.isArray(entry.notes) && entry.notes.length) {
    lines.push("", "Release notes:");
    for (const note of entry.notes) {
      lines.push(`- ${note.text}`);
    }
  }
  if (includeNotes && Array.isArray(entry.includedReleaseIds) && entry.includedReleaseIds.length > 1) {
    lines.push("", "Есть ещё изменения с прошлого запуска. Показать предыдущий релиз: /release 2");
  }
  return lines.join("\n");
}

function formatReleaseHistory(entries, limit = 10) {
  const latest = entries.slice(-limit).reverse();
  if (!latest.length) return "История релизов пока пустая.";
  return [
    "Последние релизы:",
    ...latest.map((entry, index) =>
      `${index + 1}. ${releaseTitle(entry.kind)} | ${entry.startedAt} | bot ${entry.version} | ${entry.releaseId}`,
    ),
    "",
    "Подробности: /release 1, /release 2 ...",
  ].join("\n");
}

class ReleaseTracker {
  constructor({ logPath }) {
    this.logPath = logPath;
  }

  list() {
    return readJsonLines(this.logPath);
  }

  getByDisplayIndex(index = 1) {
    const entries = this.list();
    const normalized = Math.max(1, Number(index) || 1);
    return entries.slice().reverse()[normalized - 1] || null;
  }

  format(index = 1) {
    return formatReleaseEntry(this.getByDisplayIndex(index));
  }

  formatHistory(limit = 10) {
    return formatReleaseHistory(this.list(), limit);
  }
}

module.exports = {
  ReleaseTracker,
  createReleaseEntry,
  formatReleaseEntry,
  formatReleaseHistory,
  readJsonLines,
  recordReleaseStart,
  releaseTitle,
};
