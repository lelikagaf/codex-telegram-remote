const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractAgentText,
  extractTurnAnswer,
  isAgentMessage,
  isThreadBusy,
  unseenTerminalTurns,
} = require("../src/bot");

test("извлекается текст agentMessage", () => {
  assert.equal(extractAgentText({ type: "agentMessage", text: "Готово" }), "Готово");
  assert.equal(isAgentMessage({ type: "agentMessage" }), true);
});

test("извлекается текст из content", () => {
  assert.equal(
    extractAgentText({ content: [{ type: "output_text", text: "Раз" }, { text: "Два" }] }),
    "Раз\nДва",
  );
});

test("активный чат считается занятым", () => {
  assert.equal(isThreadBusy({ status: { type: "active", activeFlags: [] } }), true);
});

test("idle-чат считается свободным", () => {
  assert.equal(isThreadBusy({ status: { type: "idle" }, turns: [] }), false);
});

test("незавершённый turn считается занятым даже без статуса active", () => {
  assert.equal(
    isThreadBusy({
      status: { type: "notLoaded" },
      turns: [{ id: "turn-1", status: "inProgress" }],
    }),
    true,
  );
});

test("из turn извлекается только финальный ответ", () => {
  assert.equal(
    extractTurnAnswer({
      items: [
        { type: "agentMessage", phase: "commentary", text: "Проверяю…" },
        { type: "agentMessage", phase: "final_answer", text: "Готово." },
      ],
    }),
    "Готово.",
  );
});

test("unseenTerminalTurns исключает активные и уже виденные turns", () => {
  const turns = unseenTerminalTurns(
    [
      { id: "done-2", status: "completed", completedAt: 20 },
      { id: "active", status: "inProgress", startedAt: 30 },
      { id: "seen", status: "completed", completedAt: 10 },
      { id: "done-1", status: "completed", completedAt: 15 },
    ],
    new Set(["seen"]),
  );
  assert.deepEqual(
    turns.map((turn) => turn.id),
    ["done-1", "done-2"],
  );
});
