const path = require("node:path");
const { CodexTelegramBot } = require("./bot");
const { discoverCodexBinary } = require("./codex-binary");
const { CodexClient } = require("./codex-client");
const { loadConfig } = require("./env");
const { createLogger } = require("./logger");
const { ReleaseTracker, formatReleaseEntry, recordReleaseStart } = require("./release-notes");
const { StateStore } = require("./state-store");
const { TelegramClient } = require("./telegram-client");

const projectRoot = path.resolve(__dirname, "..");
let telegram = null;
let codex = null;
let bot = null;

async function runSetupMode({ config, logger, stateStore }) {
  logger.warn("TELEGRAM_ALLOWED_USER_ID не задан; запущен безопасный режим определения ID");
  telegram = new TelegramClient({
    token: config.token,
    logger,
    resumeGapMs: config.resumeGapMs,
  });
  await telegram.deleteWebhook();
  await telegram.setMyCommands([{ command: "id", description: "Показать Telegram user ID" }]);

  await telegram.run({
    initialOffset: stateStore.state.lastUpdateOffset,
    onOffset: (offset) => stateStore.save({ lastUpdateOffset: offset }),
    onUpdate: async (update) => {
      const message = update.message;
      if (!message?.chat?.id || !message.from?.id) return;
      await telegram.sendMessage(
        message.chat.id,
        [
          `Ваш Telegram user ID: ${message.from.id}`,
          "",
          "Вставьте это число в TELEGRAM_ALLOWED_USER_ID файла .env и перезапустите бота.",
          "До этого момента доступ к Codex отключён.",
        ].join("\n"),
      );
    },
  });
}

async function main() {
  const config = loadConfig(projectRoot);
  const logger = createLogger(config.logLevel, config.logPath);
  const stateStore = new StateStore(config.statePath, logger);
  stateStore.load();

  if (!config.allowedUserId) {
    await runSetupMode({ config, logger, stateStore });
    return;
  }

  const launch = discoverCodexBinary({ explicitPath: config.codexBinary, logger });
  const release = recordReleaseStart({
    logPath: config.releaseLogPath,
    codexVersion: launch.version.raw,
  });
  const releaseTracker = new ReleaseTracker({ logPath: config.releaseLogPath });
  telegram = new TelegramClient({
    token: config.token,
    logger,
    resumeGapMs: config.resumeGapMs,
  });
  codex = new CodexClient({
    launch,
    cwd: config.defaultCwd,
    approvalPolicy: config.codexApprovalPolicy,
    logger,
  });
  bot = new CodexTelegramBot({ telegram, codex, stateStore, config, logger, releaseTracker });

  await bot.initialize();
  const me = await telegram.getMe();
  logger.info("Telegram-бот запущен", { username: me.username, codexVersion: launch.version.raw });

  if (config.notifyOnStart && stateStore.state.lastChatId) {
    await telegram.sendMessage(
      stateStore.state.lastChatId,
      `🟢 Бот запущен. Codex ${launch.version.raw} готов к работе.`,
    );
  }

  if (config.notifyOnStart && stateStore.state.lastChatId) {
    await telegram.sendMessage(
      stateStore.state.lastChatId,
      formatReleaseEntry(release.entry),
    );
  }

  await telegram.run({
    initialOffset: stateStore.state.lastUpdateOffset,
    onOffset: (offset) => stateStore.save({ lastUpdateOffset: offset }),
    onUpdate: (update) => bot.handleUpdate(update),
  });
}

function shutdown(signal) {
  process.stdout.write(`Получен ${signal}, остановка…\n`);
  bot?.stop();
  telegram?.stop();
  codex?.stop();
  setTimeout(() => process.exit(0), 100).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((error) => {
  const message = error?.stack || error?.message || String(error);
  process.stderr.write(`${message}\n`);
  codex?.stop();
  process.exit(error.exitCode || 1);
});
