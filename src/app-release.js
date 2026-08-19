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
  {
    id: "2026-08-19-document-batch-hardening",
    version: "0.1.4",
    sequence: 4,
    title: "Document batch hardening",
    notes: [
      "Loose Telegram documents without media_group_id are now collected longer before starting a Codex turn.",
      "Document prompts now require processing every listed file before focusing on one document.",
      "Uploaded originals are treated as read-only, and Codex is told to avoid PowerShell Get-Content/Set-Content for encoding fixes.",
    ],
  },
  {
    id: "2026-08-19-document-processing-queue",
    version: "0.1.5",
    sequence: 5,
    title: "Document processing queue",
    notes: [
      "Telegram document handling is split into accept, store and process steps.",
      "Saved document batches are put into a per-thread processing queue before Codex starts work.",
      "Queued document batches wait for the active Codex turn instead of being rejected as a busy chat.",
    ],
  },
  {
    id: "2026-08-19-incoming-message-batching",
    version: "0.1.6",
    sequence: 6,
    title: "Incoming message batching",
    notes: [
      "Non-command Telegram text and documents are now collected into one incoming message batch.",
      "The bot waits for a quiet period before processing, so one user request split across messages stays together.",
      "Processing starts only after the full batch is accepted and stored.",
    ],
  },
];

const CURRENT_RELEASE = RELEASE_HISTORY.at(-1);

module.exports = { CURRENT_RELEASE, RELEASE_HISTORY };
