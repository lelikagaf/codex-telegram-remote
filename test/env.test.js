const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseActiveWriterMode,
  parseApprovalPolicy,
  parseBoolean,
  parseEnv,
  parseFileSizeLimitMb,
} = require("../src/env");

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

test("parseActiveWriterMode принимает очередь и fork", () => {
  assert.equal(parseActiveWriterMode(undefined), "queue");
  assert.equal(parseActiveWriterMode("FORK"), "fork");
  assert.throws(() => parseActiveWriterMode("takeover"), /CODEX_ACTIVE_WRITER_MODE/);
});

test("лимит файла принимает мегабайты, 0 и -1", () => {
  assert.equal(parseFileSizeLimitMb("25"), 25 * 1024 * 1024);
  assert.equal(parseFileSizeLimitMb("0"), 0);
  assert.equal(parseFileSizeLimitMb("-1"), 0);
  assert.equal(parseFileSizeLimitMb(undefined), 0);
});

test("лимит файла отклоняет остальные отрицательные и некорректные значения", () => {
  assert.throws(() => parseFileSizeLimitMb("-2"), /TELEGRAM_MAX_FILE_SIZE_MB/);
  assert.throws(() => parseFileSizeLimitMb("много"), /TELEGRAM_MAX_FILE_SIZE_MB/);
});
