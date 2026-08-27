const test = require("node:test");
const assert = require("node:assert/strict");
const { compareCandidates, compareVersions, parseVersion } = require("../src/codex-binary");

test("parseVersion понимает версии Codex alpha", () => {
  assert.deepEqual(parseVersion("codex-cli 0.146.0-alpha.3.1"), {
    major: 0,
    minor: 146,
    patch: 0,
    prerelease: "alpha.3.1",
    raw: "0.146.0-alpha.3.1",
  });
});

test("новая minor-версия приоритетнее старой", () => {
  const oldVersion = parseVersion("0.136.0");
  const newVersion = parseVersion("0.146.0-alpha.3.1");
  assert.ok(compareVersions(newVersion, oldVersion) > 0);
});

test("стабильный релиз приоритетнее prerelease той же версии", () => {
  assert.ok(compareVersions(parseVersion("1.2.3"), parseVersion("1.2.3-alpha.1")) > 0);
});

test("при одинаковой версии выбирается комплект с code-mode host", () => {
  const version = parseVersion("0.150.0-alpha.8");
  const incomplete = { version, codeModeHostAvailable: false, modifiedAtMs: 200 };
  const complete = { version, codeModeHostAvailable: true, modifiedAtMs: 100 };
  assert.ok(compareCandidates(complete, incomplete) > 0);
});

test("при одинаковой комплектности выбирается более свежий бинарник", () => {
  const version = parseVersion("0.150.0-alpha.8");
  const older = { version, codeModeHostAvailable: true, modifiedAtMs: 100 };
  const newer = { version, codeModeHostAvailable: true, modifiedAtMs: 200 };
  assert.ok(compareCandidates(newer, older) > 0);
});
