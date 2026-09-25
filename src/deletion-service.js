"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MAX_TARGETS = 100;
const REMOTE_PROTECTED_PATHS = new Set(["/", "/bin", "/boot", "/dev", "/etc", "/home", "/opt", "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/tmp", "/usr", "/var"]);

function normalizeStringArray(values, label) {
  if (!Array.isArray(values) || !values.length) {
    throw new Error(`${label} должен содержать хотя бы один путь.`);
  }
  if (values.length > MAX_TARGETS) {
    throw new Error(`${label} содержит больше ${MAX_TARGETS} путей.`);
  }
  return values.map((value) => {
    const result = String(value || "").trim();
    if (!result) throw new Error(`${label} содержит пустой путь.`);
    if (result.length > 4096) throw new Error(`${label} содержит слишком длинный путь.`);
    return result;
  });
}

function localPathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".."
    && !relative.startsWith(`..${path.sep}`));
}

function realPathIfPresent(value) {
  try {
    return fs.realpathSync(value);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return value;
    throw error;
  }
}

function defaultProtectedLocalPaths(extra = []) {
  return [
    os.homedir(),
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramData,
    path.resolve(__dirname, ".."),
    ...extra,
  ].filter(Boolean);
}

function normalizeLocalTargets(values, { protectedPaths = [] } = {}) {
  const rawPaths = normalizeStringArray(values, "paths");
  const protectedKeys = defaultProtectedLocalPaths(protectedPaths)
    .flatMap((value) => [localPathKey(value), localPathKey(realPathIfPresent(value))]);
  const targets = [];
  const seen = new Set();
  for (const rawPath of rawPaths) {
    if (!path.isAbsolute(rawPath) || rawPath.includes("\0")) {
      throw new Error(`Локальный путь должен быть абсолютным: ${rawPath}`);
    }
    const resolved = path.resolve(rawPath);
    const root = path.parse(resolved).root;
    const key = localPathKey(resolved);
    if (key === localPathKey(root)) {
      throw new Error(`Удаление корня диска запрещено: ${resolved}`);
    }
    // Resolve parent junctions, but preserve a final symlink so only the link is removed.
    const actualKey = localPathKey(path.join(realPathIfPresent(path.dirname(resolved)), path.basename(resolved)));
    if (protectedKeys.some((protectedKey) => containsPath(key, protectedKey)
      || containsPath(actualKey, protectedKey))) {
      throw new Error(`Удаление защищенного корневого каталога запрещено: ${resolved}`);
    }
    if (!seen.has(key)) {
      seen.add(key);
      targets.push(resolved);
    }
  }
  return targets.filter((candidate) => {
    const candidateKey = localPathKey(candidate);
    return !targets.some((parent) => {
      const parentKey = localPathKey(parent);
      return parentKey !== candidateKey && containsPath(parentKey, candidateKey);
    });
  });
}

function inspectLocalTarget(target) {
  const initial = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!initial) return { path: target, missing: true, files: 0, directories: 0, bytes: 0 };
  if (!initial.isDirectory() || initial.isSymbolicLink()) {
    return { path: target, missing: false, files: 1, directories: 0, bytes: initial.size };
  }
  let files = 0;
  let directories = 1;
  let bytes = 0;
  const pending = [target];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      const stat = fs.lstatSync(child);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        directories += 1;
        pending.push(child);
      } else {
        files += 1;
        bytes += stat.size;
      }
    }
  }
  return { path: target, missing: false, files, directories, bytes };
}

function deleteLocalPaths(paths, options = {}) {
  const targets = normalizeLocalTargets(paths, options);
  const inspected = targets.map(inspectLocalTarget);
  for (const item of inspected) {
    if (!item.missing) fs.rmSync(item.path, { recursive: true, force: false });
  }
  const failed = inspected.filter((item) => fs.lstatSync(item.path, { throwIfNoEntry: false }));
  if (failed.length) throw new Error(`Не удалось удалить: ${failed.map((item) => item.path).join(", ")}`);
  return {
    status: "completed",
    deletedPaths: inspected.filter((item) => !item.missing).map((item) => item.path),
    missingPaths: inspected.filter((item) => item.missing).map((item) => item.path),
    files: inspected.reduce((sum, item) => sum + item.files, 0),
    directories: inspected.reduce((sum, item) => sum + item.directories, 0),
    bytes: inspected.reduce((sum, item) => sum + item.bytes, 0),
  };
}

function normalizeRemoteTargets(values) {
  const targets = [];
  const seen = new Set();
  for (const rawPath of normalizeStringArray(values, "paths")) {
    if (!rawPath.startsWith("/") || rawPath.includes("\0")) {
      throw new Error(`Удаленный путь должен быть абсолютным POSIX-путем: ${rawPath}`);
    }
    const normalized = path.posix.resolve(rawPath);
    if (REMOTE_PROTECTED_PATHS.has(normalized)) {
      throw new Error(`Удаление защищенного удаленного корня запрещено: ${normalized}`);
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      targets.push(normalized);
    }
  }
  return targets.filter((candidate) => !targets.some(
    (parent) => parent !== candidate && candidate.startsWith(`${parent}/`),
  ));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

const REMOTE_DELETE_SCRIPT = [
  "import base64,json,os,shutil,sys",
  "paths=json.loads(base64.b64decode(sys.argv[1]).decode())",
  "protected={'/','/bin','/boot','/dev','/etc','/home','/opt','/proc','/root','/run','/sbin','/srv','/sys','/tmp','/usr','/var'}",
  "result={'deletedPaths':[],'missingPaths':[],'files':0,'directories':0,'bytes':0}",
  "for raw in paths:",
  " p=os.path.normpath(raw)",
  " actual=os.path.normpath(os.path.join(os.path.realpath(os.path.dirname(p)),os.path.basename(p)))",
  " if not p.startswith('/') or p in protected or actual in protected: raise RuntimeError('protected or relative path: '+p)",
  " if not os.path.lexists(p): result['missingPaths'].append(p); continue",
  " if os.path.islink(p) or not os.path.isdir(p):",
  "  result['files']+=1; result['bytes']+=os.lstat(p).st_size",
  " else:",
  "  result['directories']+=1",
  "  for root,dirs,files in os.walk(p,followlinks=False):",
  "   result['directories']+=len(dirs)",
  "   for name in files:",
  "    child=os.path.join(root,name); result['files']+=1; result['bytes']+=os.lstat(child).st_size",
  " result['deletedPaths'].append(p)",
  "for p in result['deletedPaths']:",
  " shutil.rmtree(p) if os.path.isdir(p) and not os.path.islink(p) else os.unlink(p)",
  " if os.path.lexists(p): raise RuntimeError('deletion verification failed: '+p)",
  "result['status']='completed'",
  "print(json.dumps(result,separators=(',',':')))"
].join("\n");

function deleteRemotePaths({ host, user, port = 22, identityFile = null, paths }, {
  spawnSyncImpl = spawnSync,
  timeoutMs = 600_000,
} = {}) {
  const safeHost = String(host || "").trim();
  const safeUser = String(user || "").trim();
  const safePort = Number(port || 22);
  if (!/^[a-zA-Z0-9_\[]+[a-zA-Z0-9._:[\]-]*$/.test(safeHost)) throw new Error("Некорректный SSH host.");
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/.test(safeUser)) throw new Error("Некорректный SSH user.");
  if (!Number.isSafeInteger(safePort) || safePort < 1 || safePort > 65535) {
    throw new Error("Некорректный SSH port.");
  }
  const remotePaths = normalizeRemoteTargets(paths);
  const sshArgs = [
    "-p", String(safePort),
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=15",
  ];
  if (identityFile) {
    const keyPath = path.resolve(String(identityFile));
    if (!path.isAbsolute(String(identityFile)) || !fs.existsSync(keyPath)) {
      throw new Error(`SSH identity file не найден: ${identityFile}`);
    }
    sshArgs.push("-i", keyPath, "-o", "IdentitiesOnly=yes");
  }
  const payload = Buffer.from(JSON.stringify(remotePaths), "utf8").toString("base64");
  const remoteCommand = `python3 -c ${shellQuote(REMOTE_DELETE_SCRIPT)} ${shellQuote(payload)}`;
  sshArgs.push(`${safeUser}@${safeHost}`, remoteCommand);
  const result = spawnSyncImpl("ssh", sshArgs, {
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `ssh exit ${result.status}`).trim());
  }
  const output = String(result.stdout || "").trim();
  const parsed = JSON.parse(output || "{}");
  return { ...parsed, host: safeHost, user: safeUser, port: safePort };
}

module.exports = {
  MAX_TARGETS,
  REMOTE_PROTECTED_PATHS,
  deleteLocalPaths,
  deleteRemotePaths,
  normalizeLocalTargets,
  normalizeRemoteTargets,
  shellQuote,
};
