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
