// Команда показывает только ID отправителя, без чтения переписки и назначения прав.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(os.tmpdir(), "zavod-myid-"));
process.env.DATA_DIR = dir;
process.env.ZAVOD_ENV_FILE = path.join(dir, "absent.env");
process.env.TG_BOT_TOKEN = "test-token";
process.env.APPROVER_IDS = "";
delete process.env.TG_RELAY_URL;
const sent = [];
globalThis.fetch = async (url, init) => {
  sent.push({ method: String(url).split("/").pop(), body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ ok: true, result: { message_id: 100 } }));
};
const { handleCommand } = await import("../src/bot/staff.mjs");
const { stopState, isHeld } = await import("../src/queue/switch.mjs");
test.after(() => rmSync(dir, { recursive: true, force: true }));

test("myid: свой ID до назначения прав, ответ в той же теме, выпуск не меняется", async () => {
  const before = { stop: stopState(), held: isHeld() };
  for (const text of ["/myid", "/myid@EcopolisKZNbot"]) {
    sent.length = 0;
    assert.equal(await handleCommand({ text, chat: { id: -1001 }, message_thread_id: 70,
      from: { id: 123456789, username: "owner" }, forward_origin: { sender_user: { id: 999 } } }), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, "sendMessage");
    assert.equal(sent[0].body.chat_id, -1001);
    assert.equal(sent[0].body.message_thread_id, 70);
    assert.match(sent[0].body.text, /<code>123456789<\/code>/);
    assert.ok(!sent[0].body.text.includes("999"));
  }
  assert.deepEqual({ stop: stopState(), held: isHeld() }, before);
});

test("myid: анонимный администратор и отсутствующий отправитель не дают чужой ID", async () => {
  for (const extra of [{}, { from: { id: 1087968824, is_bot: true } },
    { from: { id: 123 }, sender_chat: { id: -1001 } }]) {
    sent.length = 0;
    assert.equal(await handleCommand({ text: "/myid", chat: { id: -1001 }, ...extra }), true);
    assert.match(sent[0].body.text, /от своего личного аккаунта/);
    assert.ok(!sent[0].body.text.includes("<code>"));
  }
});

test("help: команда получения ID видна сотруднику", async () => {
  sent.length = 0;
  await handleCommand({ text: "/help", chat: { id: -1001 } });
  assert.match(sent[0].body.text, /\/myid/);
});
