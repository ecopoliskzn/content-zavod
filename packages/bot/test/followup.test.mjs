import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTgStore } from "../src/telegram/store.mjs";
import { createFollowupEngine } from "../src/telegram/followup.mjs";

const scenarios = {
  material: [
    { afterHours: 24, text: (s) => `дожим 1 про ${s}` },
    { afterHours: 48, text: (s) => `дожим 2 про ${s}` },
  ],
};

function fixture({ send, quietHours } = {}) {
  const каталог = mkdtempSync(join(tmpdir(), "liga-bot-followup-"));
  const store = createTgStore({ subsFile: join(каталог, "subs.jsonl"), eventsFile: join(каталог, "events.jsonl") });
  const sent = [];
  const engine = createFollowupEngine({
    store,
    scenarios,
    send: send || (async (id, text) => (sent.push({ id, text }), { ok: true, status: 200 })),
    quietHours: quietHours || (() => false),
  });
  return { store, engine, sent, каталог };
}

test("требует store и send", () => {
  assert.throws(() => createFollowupEngine({ scenarios }));
  assert.throws(() => createFollowupEngine({ store: {}, scenarios }));
});

test("schedule ставит первый шаг через steps[0].afterHours", async () => {
  const { store, engine } = fixture();
  await store.upsertSubscriber("1", { status: "active" });
  const с = await engine.schedule("1", "материал X", "material");
  assert.equal(с.followup.step, 0);
  assert.equal(с.followup.subject, "материал X");
  assert.ok(new Date(с.followup.nextAt).getTime() > Date.now());
});

test("cancel снимает цепочку", async () => {
  const { store, engine } = fixture();
  await engine.schedule("1", "x", "material");
  await engine.cancel("1");
  const с = await store.findSubscriber("1");
  assert.equal(с.followup, null);
});

test("tick не трогает подписчика раньше срока", async () => {
  const { store, engine, sent } = fixture();
  await engine.schedule("1", "x", "material");
  const итог = await engine.tick(new Date());
  assert.equal(итог.sent, 0);
  assert.equal(sent.length, 0);
});

test("tick отправляет назревший шаг и продвигает step/nextAt", async () => {
  const { store, engine, sent } = fixture();
  await engine.schedule("1", "материал X", "material");
  const через25ч = new Date(Date.now() + 25 * 3600_000);
  const итог = await engine.tick(через25ч);
  assert.equal(итог.sent, 1);
  assert.equal(sent[0].text, "дожим 1 про материал X");
  const с = await store.findSubscriber("1");
  assert.equal(с.followup.step, 1);
});

test("после последнего шага followup снимается", async () => {
  const { store, engine } = fixture();
  await store.upsertSubscriber("1", { followup: { scenario: "material", step: 1, nextAt: new Date(0).toISOString(), subject: "x" } });
  await engine.tick(new Date());
  const с = await store.findSubscriber("1");
  assert.equal(с.followup, null);
});

test("тихие часы: tick ничего не отправляет, skipped=-1", async () => {
  const { engine, sent } = fixture({ quietHours: () => true });
  await engine.schedule("1", "x", "material");
  const итог = await engine.tick(new Date());
  assert.equal(итог.skipped, -1);
  assert.equal(sent.length, 0);
});

test("заблокировавший (403) снимается со статусом blocked, цепочка гасится", async () => {
  const { store, engine } = fixture({ send: async () => ({ ok: false, status: 403 }) });
  await engine.schedule("1", "x", "material");
  const итог = await engine.tick(new Date(Date.now() + 25 * 3600_000));
  assert.equal(итог.blocked, 1);
  const с = await store.findSubscriber("1");
  assert.equal(с.status, "blocked");
  assert.equal(с.followup, null);
});

test("cancel до отправки шага 2 останавливает дожим (сценарий 'отменяет после лида')", async () => {
  const { store, engine, sent } = fixture();
  await engine.schedule("1", "x", "material");
  await engine.tick(new Date(Date.now() + 25 * 3600_000)); // шаг 0 отправлен, step=1
  assert.equal(sent.length, 1);
  await engine.cancel("1"); // человек оставил заявку — дожим больше не нужен
  await engine.tick(new Date(Date.now() + 100 * 3600_000));
  assert.equal(sent.length, 1, "после cancel новых сообщений быть не должно");
});

test("canSend: шаг без разрешения не уходит и не сдвигает цепочку, с разрешением — уходит", async () => {
  const каталог = mkdtempSync(join(tmpdir(), "liga-bot-followup-cs-"));
  const store = createTgStore({ subsFile: join(каталог, "subs.jsonl"), eventsFile: join(каталог, "events.jsonl") });
  const sent = [];
  const engine = createFollowupEngine({
    store,
    scenarios,
    send: async (id, text) => (sent.push({ id, text }), { ok: true, status: 200 }),
    quietHours: () => false,
    canSend: (sub) => sub.consentAds?.value === true,
  });
  await store.upsertSubscriber("7", { status: "active" });
  await engine.schedule("7", "X", "material");
  const позже = new Date(Date.now() + 25 * 3600_000);

  let итог = await engine.tick(позже);
  assert.equal(итог.sent, 0);
  assert.equal(sent.length, 0);
  assert.equal((await store.findSubscriber("7")).followup.step, 0);

  await store.upsertSubscriber("7", { consentAds: { value: true, at: new Date().toISOString() } });
  итог = await engine.tick(позже);
  assert.equal(итог.sent, 1);
  rmSync(каталог, { recursive: true, force: true });
});
