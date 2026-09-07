const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TelegramClient, TelegramApiError, TelegramFileTooLargeError } = require("../src/telegram-client");

function client() {
  return new TelegramClient({
    token: "test-token",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
}

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-transport-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("Bot API call sends JSON and unwraps its successful result", async (t) => {
  const calls = [];
  t.mock.method(global, "fetch", async (url, options) => {
    calls.push({ url, options });
    return Response.json({ ok: true, result: { message_id: 12 } });
  });
  const result = await client().call("sendMessage", { chat_id: -100123, text: "Hello" });
  assert.deepEqual(result, { message_id: 12 });
  assert.equal(calls[0].url, "https://api.telegram.org/bottest-token/sendMessage");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].options.body), { chat_id: -100123, text: "Hello" });
});

for (const [status, code] of [[403, 403], [200, 400]]) {
  test(`Bot API error is preserved with HTTP ${status}`, async (t) => {
    t.mock.method(global, "fetch", async () => Response.json({
      ok: false, error_code: code, description: "not enough rights",
    }, { status }));
    await assert.rejects(client().createForumTopic(-100123, "Alpha"), (error) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.method, "createForumTopic");
      assert.equal(error.errorCode, code);
      assert.match(error.message, /not enough rights/);
      return true;
    });
  });
}

test("malformed API JSON is rejected instead of reported as success", async (t) => {
  t.mock.method(global, "fetch", async () => new Response("not json"));
  await assert.rejects(client().getMe(), SyntaxError);
});

test("network failure from the Bot API is propagated", async (t) => {
  const failure = new Error("connection reset");
  t.mock.method(global, "fetch", async () => { throw failure; });
  await assert.rejects(client().getMe(), (error) => error === failure);
});

test("Bot API request aborts when its timeout expires", async (t) => {
  t.mock.method(global, "fetch", (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  await assert.rejects(client().call("getMe", {}, 5), { name: "AbortError" });
});

test("createForumTopic preserves negative group IDs, options and the title length limit", async () => {
  const telegram = client();
  const calls = [];
  telegram.call = async (method, payload) => { calls.push({ method, payload }); return { message_thread_id: 77 }; };
  const result = await telegram.createForumTopic(-100123, "a".repeat(140), { icon_color: 7322096 });
  assert.deepEqual(calls, [{ method: "createForumTopic", payload: {
    chat_id: -100123, name: "a".repeat(128), icon_color: 7322096,
  } }]);
  assert.equal(result.message_thread_id, 77);
});

test("editMessage keeps the topic, message ID and additional options", async () => {
  const telegram = client();
  telegram.call = async (method, payload) => {
    assert.equal(method, "editMessageText");
    assert.deepEqual(payload, {
      chat_id: -100123, message_thread_id: 77, message_id: 55, text: "Progress",
      parse_mode: "HTML", disable_web_page_preview: true,
    });
    return true;
  };
  assert.equal(await telegram.editMessage({ chatId: -100123, messageThreadId: 77 }, 55, "Progress", { parse_mode: "HTML" }), true);
});

test("legacy numeric chat target sends no topic ID", async () => {
  const telegram = client();
  let payload;
  telegram.call = async (method, body) => { payload = body; };
  await telegram.sendMessage(123, "Private message");
  assert.equal(payload.chat_id, 123);
  assert.equal(Object.hasOwn(payload, "message_thread_id"), false);
});

test("long answers preserve all text and route every chunk to the same topic", async () => {
  const telegram = client();
  const calls = [];
  telegram.call = async (method, payload) => {
    calls.push(payload);
    return { message_id: calls.length };
  };
  const text = "x".repeat(9000);
  const messages = await telegram.sendLongMessage({ chatId: -100123, messageThreadId: 77 }, text, { disable_notification: true });
  assert.equal(messages.length, 3);
  assert.equal(calls.map((item) => item.text).join(""), text);
  for (const call of calls) {
    assert.equal(call.chat_id, -100123);
    assert.equal(call.message_thread_id, 77);
    assert.equal(call.disable_notification, true);
    assert.ok(call.text.length <= 4096);
  }
});

test("long answer delivery stops at a failed chunk", async () => {
  const telegram = client();
  let attempts = 0;
  telegram.call = async () => {
    if (++attempts === 2) throw new Error("send failed");
    return { message_id: attempts };
  };
  await assert.rejects(telegram.sendLongMessage(123, "x".repeat(12000)), /send failed/);
  assert.equal(attempts, 2);
});

test("sendDocument uploads exact bytes and includes topic and caption in multipart data", async (t) => {
  const directory = tempDirectory(t);
  const filePath = path.join(directory, "report.bin");
  const bytes = Buffer.from([0, 255, 128, 13, 10, 65]);
  fs.writeFileSync(filePath, bytes);
  let uploads = 0;
  t.mock.method(global, "fetch", async (url, { body }) => {
    uploads++;
    assert.ok(url.endsWith("/sendDocument"));
    assert.equal(body.get("chat_id"), "-100123");
    assert.equal(body.get("message_thread_id"), "77");
    assert.equal(body.get("caption"), "Report");
    assert.equal(body.get("disable_notification"), "true");
    assert.equal(body.has("unused"), false);
    const file = body.get("document");
    assert.equal(file.name, "report.bin");
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
    return Response.json({ ok: true, result: { message_id: 90 } });
  });
  const result = await client().sendDocument({ chatId: -100123, messageThreadId: 77 }, filePath, {
    caption: "Report", disable_notification: true, unused: null,
  });
  assert.equal(uploads, 1);
  assert.equal(result.message_id, 90);
});

test("sendDocument preserves Telegram upload errors", async (t) => {
  const filePath = path.join(tempDirectory(t), "report.txt");
  fs.writeFileSync(filePath, "Report");
  t.mock.method(global, "fetch", async () => Response.json({
    ok: false, error_code: 400, description: "file too large",
  }, { status: 400 }));
  await assert.rejects(client().sendDocument(123, filePath), (error) => {
    assert.ok(error instanceof TelegramApiError);
    assert.equal(error.method, "sendDocument");
    assert.equal(error.errorCode, 400);
    return true;
  });
});

test("missing local document fails before contacting Telegram", async (t) => {
  const fetchMock = t.mock.method(global, "fetch", async () => assert.fail("Unexpected upload"));
  await assert.rejects(client().sendDocument(123, path.join(tempDirectory(t), "missing.txt")), { code: "ENOENT" });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("getFile without a path fails before downloading", async (t) => {
  const telegram = client();
  telegram.getFile = async () => ({ file_size: 5 });
  const fetchMock = t.mock.method(global, "fetch", async () => assert.fail("Unexpected download"));
  await assert.rejects(telegram.downloadFile("file", path.join(tempDirectory(t), "file.txt")), /не вернул путь/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("download size advertised by getFile is checked before HTTP download", async (t) => {
  const telegram = client();
  telegram.getFile = async () => ({ file_path: "docs/large", file_size: 11 });
  const fetchMock = t.mock.method(global, "fetch", async () => assert.fail("Unexpected download"));
  await assert.rejects(telegram.downloadFile("file", path.join(tempDirectory(t), "file.bin"), { maxBytes: 10 }), TelegramFileTooLargeError);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("download rejects an oversized HTTP Content-Length before creating a file", async (t) => {
  const telegram = client();
  const directory = tempDirectory(t);
  telegram.getFile = async () => ({ file_path: "docs/large" });
  t.mock.method(global, "fetch", async () => new Response("content", { headers: { "content-length": "11" } }));
  await assert.rejects(telegram.downloadFile("file", path.join(directory, "file.bin"), { maxBytes: 10 }), TelegramFileTooLargeError);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("interrupted download preserves the original file and removes its partial replacement", async (t) => {
  const telegram = client();
  const directory = tempDirectory(t);
  const destination = path.join(directory, "original.bin");
  const original = Buffer.from([0, 255, 10]);
  fs.writeFileSync(destination, original);
  telegram.getFile = async () => ({ file_path: "docs/source" });
  let chunks = 0;
  t.mock.method(global, "fetch", async () => new Response(new ReadableStream({
    pull(controller) {
      if (chunks++ === 0) controller.enqueue(Uint8Array.from([1, 2, 3]));
      else controller.error(new Error("stream interrupted"));
    },
  })));
  await assert.rejects(telegram.downloadFile("file", destination), /stream interrupted/);
  assert.deepEqual(fs.readFileSync(destination), original);
  assert.deepEqual(fs.readdirSync(directory), ["original.bin"]);
});

test("download keeps BOM and multibyte text intact across arbitrary chunk boundaries", async (t) => {
  const telegram = client();
  const destination = path.join(tempDirectory(t), "document.md");
  const bytes = Buffer.from("\ufeff\u041e\u0442\u0447\u0451\u0442\r\n", "utf8");
  telegram.getFile = async () => ({ file_path: "docs/text" });
  t.mock.method(global, "fetch", async () => new Response(new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  })));
  const result = await telegram.downloadFile("file", destination, { maxBytes: bytes.length });
  assert.equal(result.size, bytes.length);
  assert.deepEqual(fs.readFileSync(destination), bytes);
});

test("polling processes each update sequentially before advancing its offset", { timeout: 1000 }, async () => {
  const telegram = client();
  const events = [];
  let polls = 0;
  telegram.call = async (method, payload) => {
    assert.equal(method, "getUpdates");
    if (polls++ === 0) {
      assert.equal(payload.offset, 10);
      return [{ update_id: 10 }, { update_id: 11 }];
    }
    assert.equal(payload.offset, 12);
    telegram.stop();
    return [];
  };
  await telegram.run({ initialOffset: 10,
    onUpdate: async ({ update_id }) => {
      events.push(`start:${update_id}`);
      await Promise.resolve();
      events.push(`end:${update_id}`);
    },
    onOffset: (offset) => events.push(`offset:${offset}`),
  });
  assert.deepEqual(events, ["start:10", "end:10", "offset:11", "start:11", "end:11", "offset:12"]);
});

test("one failed update is logged without blocking following updates", { timeout: 1000 }, async () => {
  const telegram = client();
  const handled = [];
  const errors = [];
  const offsets = [];
  telegram.logger.error = (...args) => errors.push(args);
  telegram.call = async () => [{ update_id: 10 }, { update_id: 11 }];
  await telegram.run({
    onUpdate: async ({ update_id }) => {
      if (update_id === 10) throw new Error("handler failed");
      handled.push(update_id);
      telegram.stop();
    },
    onOffset: (offset) => offsets.push(offset),
  });
  assert.deepEqual(handled, [11]);
  assert.deepEqual(offsets, [11, 12]);
  assert.equal(errors.length, 1);
});
