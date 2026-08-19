const RELEASE_HISTORY = [
  {
    id: "2026-08-13-file-return",
    version: "0.1.1",
    sequence: 1,
    title: "File return",
    notes: [
      "Added sending generated files from Codex back to Telegram.",
      "Added multiple outgoing documents per final answer.",
      "Blocked sensitive paths such as .env, logs, data, .git and service folders.",
    ],
  },
  {
    id: "2026-08-14-release-notes",
    version: "0.1.2",
    sequence: 2,
    title: "Release notes",
    notes: [
      "Added startup version journal in data/releases.jsonl.",
      "Added restart, update and rollback detection without reading git at runtime.",
      "Added Telegram commands /release and /releases.",
    ],
  },
  {
    id: "2026-08-19-model-settings",
    version: "0.1.3",
    sequence: 3,
    title: "Model settings",
    notes: [
      "Added /model to show the current Codex model and reasoning effort.",
      "Added changing the model and reasoning effort for the selected chat.",
      "Model and effort choices are read dynamically from Codex app-server.",
    ],
  },
];

const CURRENT_RELEASE = RELEASE_HISTORY.at(-1);

module.exports = { CURRENT_RELEASE, RELEASE_HISTORY };
