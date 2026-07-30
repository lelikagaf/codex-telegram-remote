const path = require("node:path");
const { discoverCodexBinary } = require("../src/codex-binary");
const { CodexClient } = require("../src/codex-client");
const { loadEnvFile } = require("../src/env");
const { createLogger } = require("../src/logger");
const { threadTitle } = require("../src/format");

const projectRoot = path.resolve(__dirname, "..");
loadEnvFile(path.join(projectRoot, ".env"));
const logger = createLogger(process.env.LOG_LEVEL || "info");
const defaultCwd =
  process.env.CODEX_DEFAULT_CWD ||
  path.join(process.env.USERPROFILE || projectRoot, "Documents", "Codex");
const launch = discoverCodexBinary({
  explicitPath: process.env.CODEX_BINARY || null,
  logger,
});
const client = new CodexClient({ launch, cwd: defaultCwd, logger });

(async () => {
  try {
    const result = await client.listThreads({ limit: 10 });
    console.log(`\nCodex ${launch.version.raw}: найдено ${result.data?.length || 0} чатов на странице.\n`);
    (result.data || []).forEach((thread, index) => {
      console.log(`${index + 1}. ${threadTitle(thread)}`);
      console.log(`   ${thread.cwd || "—"}`);
    });
  } finally {
    client.stop();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
