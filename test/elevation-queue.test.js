const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ElevationQueue, requestDigest, validateRequest } = require("../src/elevation-queue");

test("elevation queue preserves the exact command and creates a one-shot approval", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-elevation-"));
  try {
    const queue = new ElevationQueue({
      spoolPath: directory,
      taskName: "Test Elevated Helper",
      timeoutMs: 60_000,
    });
    const request = queue.createRequest({
      threadId: "thread-1",
      command: "powercfg /requests\nGet-Date",
      cwd: "C:\\Project",
      reason: "Нужны права администратора",
    });

    assert.equal(queue.listPendingRequests().length, 1);
    assert.equal(queue.readRequest(request.id).command, "powercfg /requests\nGet-Date");
    const approved = queue.approve(request.id);
    assert.equal(approved.digest, requestDigest(approved));
    assert.match(approved.approvedAt, /^\d{4}-/);

    queue.deny(request.id, "Отменено тестом");
    assert.deepEqual(queue.readResult(request.id).status, "denied");
    assert.equal(queue.listPendingRequests().length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("elevation queue rejects a modified approved command", () => {
  const request = {
    id: "a".repeat(32),
    threadId: "thread-1",
    command: "whoami",
    cwd: "C:\\Project",
  };
  request.digest = requestDigest(request);
  validateRequest(request);
  request.command = "Remove-Item C:\\Project";
  assert.throws(() => validateRequest(request), /Контрольная сумма/);
});
