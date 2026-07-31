const fs = require("node:fs");
const path = require("node:path");

class StateStore {
  constructor(filePath, logger) {
    this.filePath = filePath;
    this.logger = logger;
    this.state = {
      currentThreadId: null,
      currentThreadName: null,
      lastChatId: null,
      lastListedThreadIds: [],
      lastUpdateOffset: 0,
      desktopSyncThreadId: null,
      desktopSyncSeenTurnIds: null,
      desktopSyncSentUserMessageIds: [],
      desktopSyncSentUserTurnIds: [],
      telegramTurnIds: [],
      telegramPendingFinals: [],
      telegramFinalDeliveredTurnIds: null,
    };
  }

  load() {
    if (!fs.existsSync(this.filePath)) return this.state;
    try {
      const stored = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      this.state = { ...this.state, ...stored };
    } catch (error) {
      this.logger.warn("Не удалось прочитать состояние; используются значения по умолчанию", error.message);
    }
    return this.state;
  }

  save(patch = {}) {
    this.state = { ...this.state, ...patch };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, this.filePath);
    return this.state;
  }
}

module.exports = { StateStore };
