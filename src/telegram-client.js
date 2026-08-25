const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { splitText } = require("./format");

class TelegramFileTooLargeError extends Error {
  constructor(actualBytes, limitBytes) {
    super(`Размер файла ${actualBytes} байт превышает лимит ${limitBytes} байт.`);
    this.name = "TelegramFileTooLargeError";
    this.actualBytes = actualBytes;
    this.limitBytes = limitBytes;
  }
}

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
    this.fileBaseUrl = `https://api.telegram.org/file/bot${token}`;
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

  async getMe() {
    const me = await this.call("getMe");
    this.me = me;
    this.botUserId = me?.id;
    return me;
  }

  getFile(fileId) {
    return this.call("getFile", { file_id: fileId });
  }

  async downloadFile(fileId, destinationPath, { maxBytes = 0, timeoutMs = 600000 } = {}) {
    const file = await this.getFile(fileId);
    if (!file?.file_path) throw new Error("Telegram getFile не вернул путь к документу.");
    if (maxBytes > 0 && Number(file.file_size) > maxBytes) {
      throw new TelegramFileTooLargeError(Number(file.file_size), maxBytes);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const temporaryPath = `${destinationPath}.${process.pid}.${Date.now()}.part`;
    let handle = null;
    let totalBytes = 0;

    try {
      const response = await fetch(`${this.fileBaseUrl}/${file.file_path}`, {
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Telegram не отдал документ: HTTP ${response.status}.`);
      }

      const contentLength = Number(response.headers.get("content-length"));
      if (maxBytes > 0 && Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new TelegramFileTooLargeError(contentLength, maxBytes);
      }

      await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
      handle = await fs.promises.open(temporaryPath, "wx");
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (maxBytes > 0 && totalBytes > maxBytes) {
          controller.abort();
          throw new TelegramFileTooLargeError(totalBytes, maxBytes);
        }
        let offset = 0;
        while (offset < value.byteLength) {
          const { bytesWritten } = await handle.write(
            value,
            offset,
            value.byteLength - offset,
            null,
          );
          if (!bytesWritten) throw new Error("Не удалось записать полученный документ на диск.");
          offset += bytesWritten;
        }
      }
      await handle.close();
      handle = null;
      await fs.promises.rename(temporaryPath, destinationPath);
      return { path: destinationPath, size: totalBytes };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  deleteWebhook() {
    return this.call("deleteWebhook", { drop_pending_updates: false });
  }

  setMyCommands(commands) {
    return this.call("setMyCommands", { commands });
  }

  createForumTopic(chatId, name, extra = {}) {
    return this.call("createForumTopic", {
      chat_id: chatId,
      name: String(name || "").slice(0, 128),
      ...extra,
    });
  }

  #targetPayload(chatIdOrTarget, extra = {}) {
    if (
      chatIdOrTarget &&
      typeof chatIdOrTarget === "object" &&
      Object.hasOwn(chatIdOrTarget, "chatId")
    ) {
      return {
        chat_id: chatIdOrTarget.chatId,
        ...(chatIdOrTarget.messageThreadId
          ? { message_thread_id: chatIdOrTarget.messageThreadId }
          : {}),
        ...extra,
      };
    }
    return { chat_id: chatIdOrTarget, ...extra };
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call("sendMessage", {
      ...this.#targetPayload(chatId, extra),
      text: String(text).slice(0, 4096),
      disable_web_page_preview: true,
    });
  }

  editMessage(chatId, messageId, text, extra = {}) {
    return this.call("editMessageText", {
      ...this.#targetPayload(chatId, extra),
      message_id: messageId,
      text: String(text).slice(0, 4096),
      disable_web_page_preview: true,
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

  async sendDocument(chatId, filePath, extra = {}, timeoutMs = 600000) {
    const form = new FormData();
    const buffer = await fs.promises.readFile(filePath);
    const target = this.#targetPayload(chatId, extra);
    form.set("chat_id", String(target.chat_id));
    if (target.message_thread_id) form.set("message_thread_id", String(target.message_thread_id));
    form.set("document", new Blob([buffer]), path.basename(filePath));
    for (const [key, value] of Object.entries(target)) {
      if (
        key !== "chat_id" &&
        key !== "message_thread_id" &&
        value !== undefined &&
        value !== null
      ) {
        form.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/sendDocument`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new TelegramApiError("sendDocument", data.description, data.error_code);
      }
      return data.result;
    } finally {
      clearTimeout(timer);
    }
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

module.exports = { TelegramApiError, TelegramClient, TelegramFileTooLargeError };
