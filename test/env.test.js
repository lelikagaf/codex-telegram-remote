const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseActiveWriterMode,
  parseApprovalPolicy,
  parseBoolean,
  parseEnv,
  parseFileSizeLimitMb,
  parseNonNegativeInteger,
  parseOutgoingFileAccess,
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

test("parseActiveWriterMode принимает queue, fork и ask", () => {
  assert.equal(parseActiveWriterMode(undefined), "queue");
  assert.equal(parseActiveWriterMode("FORK"), "fork");
  assert.equal(parseActiveWriterMode("ask"), "ask");
  assert.throws(() => parseActiveWriterMode("takeover"), /CODEX_ACTIVE_WRITER_MODE/);
});

test("parseOutgoingFileAccess принимает управляемые режимы", () => {
  assert.equal(parseOutgoingFileAccess(undefined), "workspace");
  assert.equal(parseOutgoingFileAccess("ALL"), "all");
  assert.equal(parseOutgoingFileAccess("off"), "off");
  assert.throws(() => parseOutgoingFileAccess("anywhere"), /TELEGRAM_OUTGOING_FILE_ACCESS/);
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
  assert.throws(
    () => parseFileSizeLimitMb("много", 50, "TELEGRAM_OUTGOING_MAX_FILE_SIZE_MB"),
    /TELEGRAM_OUTGOING_MAX_FILE_SIZE_MB/,
  );
});

test("целочисленный лимит принимает 0 как отсутствие ограничения", () => {
  assert.equal(parseNonNegativeInteger(undefined, 10, "LIMIT"), 10);
  assert.equal(parseNonNegativeInteger("0", 10, "LIMIT"), 0);
  assert.equal(parseNonNegativeInteger("25", 10, "LIMIT"), 25);
  assert.throws(() => parseNonNegativeInteger("-1", 10, "LIMIT"), /LIMIT/);
  assert.throws(() => parseNonNegativeInteger("1.5", 10, "LIMIT"), /LIMIT/);
});
