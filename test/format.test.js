const test = require("node:test");
const assert = require("node:assert/strict");
const { splitText, threadTitle } = require("../src/format");

test("splitText не превышает лимит", () => {
  const chunks = splitText("слово ".repeat(2000), 250);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 250));
});

test("threadTitle использует имя", () => {
  assert.equal(threadTitle({ name: "  Мой   чат  ", preview: "другое" }), "Мой чат");
});
