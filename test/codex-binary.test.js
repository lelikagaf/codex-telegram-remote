const test = require("node:test");
const assert = require("node:assert/strict");
const { compareVersions, parseVersion } = require("../src/codex-binary");

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
