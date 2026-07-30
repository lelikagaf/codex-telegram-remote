const { EventEmitter } = require("node:events");
const { splitText } = require("./format");

class TelegramApiError extends Error {
  constructor(method, description, errorCode) {
    super(`Telegram ${method}: ${description || "неизвестная ошибка"}`);
    this.name = "TelegramApiError";
    this.method = method;
    this.errorCode = errorCode;
  }
}

class TelegramClient extends EventEmitter {
  constructor({ token, logger, pollTimeoutSeconds = 45, resumeGapMs = 120000 }) {
    super();
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.logger = logger;
    this.pollTimeoutSeconds = pollTimeoutSeconds;
    this.resumeGapMs = resumeGapMs;
    this.running = false;
  }

  async call(method, payload = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new TelegramApiError(method, data.description, data.error_code);
      }
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  getMe() {
    return this.call("getMe");
  }

  deleteWebhook() {
    return this.call("deleteWebhook", { drop_pending_updates: false });
  }

  setMyCommands(commands) {
    return this.call("setMyCommands", { commands });
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text: String(text).slice(0, 4096),
      disable_web_page_preview: true,
      ...extra,
    });
  }

  editMessage(chatId, messageId, text, extra = {}) {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: String(text).slice(0, 4096),
      disable_web_page_preview: true,
      ...extra,
    });
  }

  answerCallbackQuery(callbackQueryId, text = undefined) {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text: String(text).slice(0, 200) } : {}),
    });
  }

  async sendLongMessage(chatId, text, extra = {}) {
    const messages = [];
    for (const chunk of splitText(text)) {
      messages.push(await this.sendMessage(chatId, chunk, extra));
    }
    return messages;
  }

  stop() {
    this.running = false;
  }

  async run({ initialOffset = 0, onOffset = () => {}, onUpdate }) {
    this.running = true;
    let offset = initialOffset || 0;
    let backoffMs = 1000;
    let lastSuccessAt = null;

    while (this.running) {
      try {
        const updates = await this.call(
          "getUpdates",
          {
            offset,
            timeout: this.pollTimeoutSeconds,
            limit: 100,
            allowed_updates: ["message", "callback_query"],
          },
          (this.pollTimeoutSeconds + 15) * 1000,
        );

        const now = Date.now();
        if (lastSuccessAt && now - lastSuccessAt >= this.resumeGapMs) {
          this.emit("reconnected", { gapMs: now - lastSuccessAt });
        }
        lastSuccessAt = now;
        backoffMs = 1000;

        for (const update of updates) {
          try {
            await onUpdate(update);
          } catch (error) {
            this.logger.error("Ошибка обработки Telegram update", error.stack || error.message);
          }
          offset = update.update_id + 1;
          onOffset(offset);
        }
      } catch (error) {
        if (!this.running) break;
        this.logger.warn("Telegram временно недоступен; повторное подключение", {
          message: error.message,
          retryMs: backoffMs,
        });
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 30000);
      }
    }
  }
}

module.exports = { TelegramApiError, TelegramClient };
