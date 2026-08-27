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
  {
    id: "2026-08-19-unified-intake-quiet-period",
    version: "0.1.7",
    sequence: 7,
    title: "Unified intake quiet period",
    notes: [
      "All non-command Telegram text and document updates now use the same quiet period.",
      "A document followed by a text instruction is kept in one incoming batch before processing.",
      "Queued Telegram work starts after an external Desktop turn becomes idle.",
      "Removed the obsolete direct single-document handling path.",
    ],
  },
  {
    id: "2026-08-20-outgoing-file-path-detection",
    version: "0.1.8",
    sequence: 8,
    title: "Outgoing file path detection",
    notes: [
      "Outgoing file detection now recognizes Codex markdown links with C:/ Windows paths.",
      "Wrapped Windows paths such as C: followed by \\Users on the next line are rejoined before matching.",
      "File names with underscores are preserved when extracting paths for Telegram document sending.",
    ],
  },
  {
    id: "2026-08-23-writer-lease",
    version: "0.1.9",
    sequence: 9,
    title: "Shared thread writer lease",
    notes: [
      "Telegram bot now keeps selected Codex chats observable without holding a writer lock forever.",
      "Writer access is leased only for actions that write to Codex, then released after an idle timeout.",
      "If Codex Desktop already owns the selected chat writer, Telegram reports the busy state instead of failing the request.",
    ],
  },
  {
    id: "2026-08-25-full-remote-access",
    version: "0.1.10",
    sequence: 10,
    title: "Full remote access and thread release",
    notes: [
      "Full access is applied to the app-server, old and new threads, and every Telegram-started turn.",
      "Telegram unsubscribes from a thread after work so Codex Desktop can open it immediately.",
      "Added /access, /unlock and remote answers for Codex and MCP questions.",
      "Added an optional automatic fork when Codex Desktop keeps the original thread writer.",
      "Read-only history polling now works after the Telegram app-server unsubscribes.",
    ],
  },
  {
    id: "2026-08-25-telegram-topics",
    version: "0.1.11",
    sequence: 11,
    title: "Telegram topics for Codex chats",
    notes: [
      "Added /sync_topics to create Telegram topics for recent Codex chats.",
      "Incoming Telegram topic messages are routed to the mapped Codex chat without using /use.",
      "Codex replies and generated documents are sent back to the same Telegram topic.",
    ],
  },
  {
    id: "2026-08-25-topic-auth-hardening",
    version: "0.1.12",
    sequence: 12,
    title: "Telegram topic authorization hardening",
    notes: [
      "Bot and Telegram service messages from topic creation are ignored before authorization checks.",
      "Anonymous admin messages do not run commands and do not fill topics with access-denied replies.",
      "Unauthorized /sync_topics commands are covered by tests so they cannot create topics.",
    ],
  },
  {
    id: "2026-08-27-new-thread-recovery",
    version: "0.1.13",
    sequence: 13,
    title: "Reliable new chats",
    notes: [
      "New Codex chats stay attached until their first Telegram task creates a persisted rollout.",
      "A new chat left unmaterialized by a bot restart is recreated automatically before processing.",
      "Legacy orphaned chats that report no rollout are recovered without manual chat selection.",
    ],
  },
  {
    id: "2026-08-27-accurate-queue-notices",
    version: "0.1.14",
    sequence: 14,
    title: "Accurate queue notices",
    notes: [
      "Normal Telegram messages start without a misleading queue notification.",
      "Document batches also stay silent unless they are actually waiting for a busy Codex chat.",
      "Queue notices are now reserved for real Desktop or Telegram writer contention.",
    ],
  },
  {
    id: "2026-08-27-cross-chat-access",
    version: "0.1.15",
    sequence: 15,
    title: "Cross-chat access for Telegram",
    notes: [
      "Telegram-started Codex tasks can now find and read other local Codex chats, including archived history.",
      "The read-only chat bridge is attached to old, new, and automatically forked chats.",
      "Added CODEX_APP_TOOLS_ENABLED so cross-chat access can be disabled independently of filesystem, network, and SSH access.",
      "/access and /status now report whether cross-chat tools are enabled.",
    ],
  },
  {
    id: "2026-08-27-cross-chat-send-and-runtime-recovery",
    version: "0.1.16",
    sequence: 16,
    title: "Complete cross-chat actions",
    notes: [
      "Telegram tasks now receive their exact current Codex thread ID in application context.",
      "Added a tool that queues an explicitly requested message in another Codex chat, including when that chat is busy.",
      "Codex binary discovery now prefers a complete Desktop runtime containing codex-code-mode-host.exe.",
      "This restores shell, SSH, skills, and other code-mode tools after an incomplete Codex cleanup leaves duplicate binaries.",
    ],
  },
];

const CURRENT_RELEASE = RELEASE_HISTORY.at(-1);

module.exports = { CURRENT_RELEASE, RELEASE_HISTORY };
