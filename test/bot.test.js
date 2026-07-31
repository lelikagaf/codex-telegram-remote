const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractAgentText,
  extractTurnAnswer,
  extractTurnUserText,
  isAgentMessage,
  isDesktopTurnSettled,
  isTerminalTurnStatus,
  isThreadBusy,
  isUserMessage,
  shouldWaitForTurnAnswer,
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

test("из Desktop-turn извлекается сообщение пользователя", () => {
  const turn = {
    items: [
      { type: "userMessage", content: [{ type: "text", text: "Проверка" }] },
      { type: "agentMessage", phase: "final_answer", text: "Готово." },
    ],
  };
  assert.equal(isUserMessage(turn.items[0]), true);
  assert.equal(extractTurnUserText(turn), "Проверка");
});

test("unseenTerminalTurns исключает активные и уже виденные turns", () => {
  const turns = unseenTerminalTurns(
    [
      { id: "done-2", status: "completed", completedAt: 20 },
      { id: "active", status: "inProgress", startedAt: 30 },
      { id: "active-snake", status: "in_progress", startedAt: 31 },
      { id: "active-unknown", status: "active", startedAt: 32 },
      { id: "unknown", status: "newStatus", startedAt: 33 },
      { id: "seen", status: "completed", completedAt: 10 },
      { id: "done-1", status: "completed", completedAt: 15 },
      { id: "failed", status: "failed", completedAt: 25 },
      { id: "interrupted", status: "interrupted", completedAt: 30 },
    ],
    new Set(["seen"]),
  );
  assert.deepEqual(
    turns.map((turn) => turn.id),
    ["done-1", "done-2", "failed", "interrupted"],
  );
});

test("конечными считаются только известные завершённые статусы", () => {
  for (const status of ["completed", "interrupted", "failed"]) {
    assert.equal(isTerminalTurnStatus(status), true);
  }
  for (const status of ["inProgress", "in_progress", "active", undefined, "newStatus"]) {
    assert.equal(isTerminalTurnStatus(status), false);
  }
});

test("любой конечный Desktop-turn без ответа остаётся для повторного опроса", () => {
  for (const status of ["completed", "failed", "interrupted"]) {
    const turn = { id: "desktop-turn", status };
    assert.equal(shouldWaitForTurnAnswer(turn, "", false), true);
    assert.equal(shouldWaitForTurnAnswer(turn, "Готово.", false), false);
    assert.equal(shouldWaitForTurnAnswer(turn, "", true), false);
  }
});

test("Desktop-turn обрабатывается только после периода стабилизации", () => {
  const firstCompletedAt = 1000;
  assert.equal(isDesktopTurnSettled(undefined, 10000), false);
  assert.equal(isDesktopTurnSettled(firstCompletedAt, 6999), false);
  assert.equal(isDesktopTurnSettled(firstCompletedAt, 7000), true);
});
