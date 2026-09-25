const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  deleteLocalPaths,
  deleteRemotePaths,
  normalizeLocalTargets,
  normalizeRemoteTargets,
} = require("../src/deletion-service");
const {
  LOCAL_TOOL_NAME,
  SSH_TOOL_NAME,
  callTool,
  toolsForAccess,
} = require("../scripts/codex-deletion-mcp");

test("local deletion removes exact files and recursive directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-delete-"));
  const target = path.join(root, "target");
  const nested = path.join(target, "nested");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(target, "one.txt"), "one");
  fs.writeFileSync(path.join(nested, "two.txt"), "two");
  try {
    const result = deleteLocalPaths([target], { protectedPaths: [root] });
    assert.equal(result.status, "completed");
    assert.equal(result.files, 2);
    assert.equal(result.directories, 2);
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local deletion rejects protected roots and drive roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-delete-protected-"));
  try {
    assert.throws(
      () => normalizeLocalTargets([root], { protectedPaths: [root] }),
      /защищенного корневого каталога/,
    );
    assert.throws(
      () => normalizeLocalTargets([path.parse(root).root]),
      /корня диска/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("remote deletion validates roots and invokes strict SSH command", () => {
  assert.throws(() => normalizeRemoteTargets(["/"]), /защищенного удаленного корня/);
  let captured = null;
  const result = deleteRemotePaths({
    host: "server.example",
    user: "root",
    paths: ["/root/backup-one", "/root/cleanup.py"],
  }, {
    spawnSyncImpl(command, args, options) {
      captured = { command, args, options };
      return {
        status: 0,
        stdout: JSON.stringify({ status: "completed", deletedPaths: ["/root/backup-one"] }),
        stderr: "",
      };
    },
  });

  assert.equal(captured.command, "ssh");
  assert.ok(captured.args.includes("StrictHostKeyChecking=yes"));
  assert.ok(captured.args.includes("root@server.example"));
  assert.match(captured.args.at(-1), /^python3 -c /);
  assert.equal(result.host, "server.example");
  assert.equal(result.status, "completed");
});

test("MCP deletion access controls local and SSH tools", async () => {
  assert.deepEqual(toolsForAccess("off"), []);
  assert.deepEqual(toolsForAccess("local").map((tool) => tool.name), [LOCAL_TOOL_NAME]);
  assert.deepEqual(toolsForAccess("all").map((tool) => tool.name), [
    LOCAL_TOOL_NAME,
    SSH_TOOL_NAME,
  ]);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-delete-mcp-"));
  const target = path.join(root, "file.txt");
  fs.writeFileSync(target, "delete me");
  try {
    const result = await callTool("all", LOCAL_TOOL_NAME, { paths: [target] }, {
      protectedPaths: [root],
    });
    assert.equal(result.status, "completed");
    assert.equal(fs.existsSync(target), false);
    await assert.rejects(() => callTool("local", SSH_TOOL_NAME, {}), /недоступен/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local deletion rejects ancestors of protected paths before removing anything", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-delete-ancestor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const protectedPath = path.join(root, "protected");
  const file = path.join(root, "keep.txt");
  fs.mkdirSync(protectedPath);
  fs.writeFileSync(file, "keep");
  assert.throws(() => deleteLocalPaths([file, root], { protectedPaths: [protectedPath] }), /защищенного/);
  assert.equal(fs.readFileSync(file, "utf8"), "keep");
});

test("local deletion checks parent junctions but can unlink the junction itself", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-delete-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const actual = path.join(root, "actual");
  const protectedPath = path.join(actual, "protected");
  const alias = path.join(root, "alias");
  fs.mkdirSync(protectedPath, { recursive: true });
  fs.symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => deleteLocalPaths([path.join(alias, "protected")], { protectedPaths: [protectedPath] }), /защищенного/);
  deleteLocalPaths([alias], { protectedPaths: [protectedPath] });
  assert.equal(fs.existsSync(protectedPath), true);
  assert.equal(fs.lstatSync(alias, { throwIfNoEntry: false }), undefined);
});

test("local deletion removes a dangling directory link without deleting another target", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-delete-dangling-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const alias = path.join(root, "alias");
  fs.symlinkSync(path.join(root, "missing"), alias, process.platform === "win32" ? "junction" : "dir");
  const result = deleteLocalPaths([alias]);
  assert.deepEqual(result.deletedPaths, [alias]);
  assert.equal(fs.lstatSync(alias, { throwIfNoEntry: false }), undefined);
});

test("local nested targets are deduplicated with native path separators", () => {
  const parent = path.join(os.tmpdir(), "codex-delete-nesting", "parent");
  assert.deepEqual(normalizeLocalTargets([parent, path.join(parent, "child"), parent]), [parent]);
  assert.throws(() => normalizeLocalTargets(["relative/file"]), /абсолютным/);
});

for (const value of ["/", "/var/", "/tmp/..", "/home///", "/etc/../usr/"]) {
  test(`remote protected path ${value} is rejected before SSH`, () => {
    assert.throws(() => deleteRemotePaths({ host: "server.example", user: "root", paths: [value] }, {
      spawnSyncImpl() { assert.fail("SSH must not run"); },
    }), /защищенного/);
  });
}

test("SSH deletion rejects option-like host and user values", () => {
  for (const target of [{ host: "-example", user: "root" }, { host: "example", user: "-oProxyCommand" }]) {
    assert.throws(() => deleteRemotePaths({ ...target, paths: ["/tmp/one"] }, {
      spawnSyncImpl() { assert.fail("SSH must not run"); },
    }), /Некорректный SSH/);
  }
});

test("deletion descriptions require respecting permission and policy denials", () => {
  for (const tool of toolsForAccess("all")) {
    assert.match(tool.description, /must not be used to bypass/);
    assert.doesNotMatch(tool.description, /when .*blocked by policy/);
  }
});
