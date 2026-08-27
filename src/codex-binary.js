const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function parseVersion(value) {
  const match = String(value || "").match(/(\d+)\.(\d+)\.(\d+)(?:-([^\s]+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null,
    raw: match[0],
  };
}

function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease && !right.prerelease) return -1;
  if (!left.prerelease && right.prerelease) return 1;
  return String(left.prerelease || "").localeCompare(String(right.prerelease || ""), "en", {
    numeric: true,
  });
}

function executableCandidate(filePath, source) {
  return { command: filePath, argsPrefix: [], source };
}

function inspectCandidate(candidate) {
  const result = spawnSync(candidate.command, [...candidate.argsPrefix, "--version"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  const version = parseVersion(`${result.stdout || ""} ${result.stderr || ""}`);
  if (!version) return null;
  let modifiedAtMs = 0;
  try {
    modifiedAtMs = fs.statSync(candidate.command).mtimeMs;
  } catch {}
  const isDesktopBinary = path.basename(candidate.command).toLowerCase() === "codex.exe";
  const codeModeHostAvailable = isDesktopBinary
    ? fs.existsSync(path.join(path.dirname(candidate.command), "codex-code-mode-host.exe"))
    : null;
  return { ...candidate, version, modifiedAtMs, codeModeHostAvailable };
}

function compareCandidates(left, right) {
  const versionOrder = compareVersions(left.version, right.version);
  if (versionOrder) return versionOrder;
  const leftHost = left.codeModeHostAvailable === true ? 1 : 0;
  const rightHost = right.codeModeHostAvailable === true ? 1 : 0;
  if (leftHost !== rightHost) return leftHost - rightHost;
  return (left.modifiedAtMs || 0) - (right.modifiedAtMs || 0);
}

function discoverCodexBinary({ explicitPath = null, logger = console } = {}) {
  if (explicitPath) {
    if (!fs.existsSync(explicitPath)) {
      throw new Error(`CODEX_BINARY не найден: ${explicitPath}`);
    }
    const inspected = inspectCandidate(executableCandidate(explicitPath, "CODEX_BINARY"));
    if (!inspected) throw new Error(`Не удалось запустить CODEX_BINARY: ${explicitPath}`);
    return inspected;
  }

  const candidates = [];
  const desktopBinRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin")
    : null;

  if (desktopBinRoot && fs.existsSync(desktopBinRoot)) {
    for (const entry of fs.readdirSync(desktopBinRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(desktopBinRoot, entry.name, "codex.exe");
      if (fs.existsSync(filePath)) candidates.push(executableCandidate(filePath, "Codex Desktop"));
    }
  }

  const npmEntry = process.env.APPDATA
    ? path.join(
        process.env.APPDATA,
        "npm",
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js",
      )
    : null;
  if (npmEntry && fs.existsSync(npmEntry)) {
    candidates.push({ command: process.execPath, argsPrefix: [npmEntry], source: "npm fallback" });
  }

  const inspected = candidates.map(inspectCandidate).filter(Boolean);
  if (!inspected.length) {
    throw new Error(
      "Не найден рабочий Codex Desktop. При необходимости укажите полный путь в CODEX_BINARY.",
    );
  }

  inspected.sort((a, b) => compareCandidates(b, a));
  const selected = inspected[0];
  logger.info("Выбран бинарник Codex", {
    source: selected.source,
    version: selected.version.raw,
    path: selected.command,
    codeModeHostAvailable: selected.codeModeHostAvailable,
  });
  return selected;
}

module.exports = { compareCandidates, compareVersions, discoverCodexBinary, parseVersion };
