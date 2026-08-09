const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  TelegramClient,
  TelegramFileTooLargeError,
} = require("../src/telegram-client");

function createLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

test("downloadFile атомарно сохраняет документ при безлимитной настройке", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-file-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "document.md");
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => new Response("hello", { status: 200 });

  const client = new TelegramClient({ token: "test-token", logger: createLogger() });
  client.getFile = async () => ({ file_path: "documents/document.md", file_size: 5 });

  const result = await client.downloadFile("file-id", destination, { maxBytes: 0 });
  assert.equal(result.size, 5);
  assert.equal(fs.readFileSync(destination, "utf8"), "hello");
  assert.equal(fs.readdirSync(directory).some((name) => name.endsWith(".part")), false);
});

test("downloadFile удаляет временный файл при превышении лимита потоком", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-limit-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "large.bin");
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => new Response("12345", { status: 200 });

  const client = new TelegramClient({ token: "test-token", logger: createLogger() });
  client.getFile = async () => ({ file_path: "documents/large.bin" });

  await assert.rejects(
    client.downloadFile("file-id", destination, { maxBytes: 4 }),
    TelegramFileTooLargeError,
  );
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.readdirSync(directory).some((name) => name.endsWith(".part")), false);
});
