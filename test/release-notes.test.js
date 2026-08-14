const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createReleaseEntry,
  formatReleaseEntry,
  formatReleaseHistory,
  recordReleaseStart,
} = require("../src/release-notes");

const oldRelease = {
  id: "old",
  version: "1.0.0",
  sequence: 1,
  title: "Old",
  notes: ["old note"],
};
const newRelease = {
  id: "new",
  version: "1.1.0",
  sequence: 2,
  title: "New",
  notes: ["new note"],
};

test("release entry marks same current release as restart", () => {
  const entry = createReleaseEntry({
    currentRelease: newRelease,
    codexVersion: "codex-1",
    previous: { releaseId: "new" },
    now: new Date("2026-08-14T10:00:00Z"),
  });
  assert.equal(entry.kind, "restart");
  assert.deepEqual(entry.notes, []);
});

test("release entry detects update and rollback without git", () => {
  const updated = createReleaseEntry({
    currentRelease: newRelease,
    releaseHistory: [oldRelease, newRelease],
    previous: { releaseId: "old" },
  });
  const rolledBack = createReleaseEntry({
    currentRelease: oldRelease,
    releaseHistory: [oldRelease, newRelease],
    previous: { releaseId: "new" },
  });

  assert.equal(updated.kind, "update");
  assert.equal(rolledBack.kind, "rollback");
  assert.deepEqual(updated.notes.map((item) => item.text), ["new note"]);
  assert.deepEqual(rolledBack.notes.map((item) => item.text), ["old note"]);
});

test("release start appends current applied version to jsonl file", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-release-notes-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const logPath = path.join(directory, "releases.jsonl");

  const first = recordReleaseStart({
    logPath,
    currentRelease: oldRelease,
    codexVersion: "codex-a",
    now: new Date("2026-08-14T10:00:00Z"),
  });
  const second = recordReleaseStart({
    logPath,
    currentRelease: oldRelease,
    codexVersion: "codex-a",
    now: new Date("2026-08-14T10:01:00Z"),
  });

  assert.equal(first.entry.kind, "first-start");
  assert.equal(second.entry.kind, "restart");
  assert.equal(fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/).length, 2);
});

test("release formatting exposes notes and history", () => {
  const entry = {
    startedAt: "2026-08-14T10:00:00.000Z",
    kind: "update",
    version: "1.1.0",
    releaseId: "new",
    codexVersion: "codex-a",
    notes: [{ text: "new note" }],
  };

  assert.match(formatReleaseEntry(entry), /new note/);
  assert.match(formatReleaseHistory([entry]), /new/);
});
