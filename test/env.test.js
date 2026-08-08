const test = require("node:test");
const assert = require("node:assert/strict");
const { parseApprovalPolicy, parseBoolean, parseEnv } = require("../src/env");

test("parseEnv читает значения и кавычки", () => {
  assert.deepEqual(parseEnv('A=one\nB="two words"\n# C=skip\n'), {
    A: "one",
    B: "two words",
  });
});

test("parseBoolean поддерживает стандартные значения", () => {
  assert.equal(parseBoolean("true", false), true);
  assert.equal(parseBoolean("0", true), false);
  assert.equal(parseBoolean(undefined, true), true);
});

test("parseApprovalPolicy принимает известные режимы", () => {
  assert.equal(parseApprovalPolicy(undefined), "never");
  assert.equal(parseApprovalPolicy("on-request"), "on-request");
  assert.equal(parseApprovalPolicy("UNTRUSTED"), "untrusted");
});

test("parseApprovalPolicy отклоняет неизвестный режим", () => {
  assert.throws(() => parseApprovalPolicy("always"), /CODEX_APPROVAL_POLICY/);
});
