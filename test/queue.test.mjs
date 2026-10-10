// Очередь: формат, переходы статусов, слоты, хранилище. Без сети.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "zavod-queue-"));

const { canMove, entryId, contentHash, entryHash, normalize, splitPosts, validate, preview } = await import("../src/queue/format.mjs");
const { nextSlot } = await import("../src/queue/slots.mjs");
const store = await import("../src/queue/store.mjs");

const thread = (over = {}) => ({
  channel: "threads", kind: "thread", name: "priemka-tolshchina", material: "blog:kuda-ischezajut-millimetry",
  date: "2026-10-15", time: "19:00", posts: ["Подрядчик сдал площадку, а через год она крошится.", "Причина нашлась в акте: толщину никто не мерил."], ...over,
});

test("splitPosts режет по строке из трёх дефисов и выбрасывает пустое", () => {
  assert.deepEqual(splitPosts("раз\n---\nдва\n---\n\n"), ["раз", "два"]);
});

test("номер записи зависит от площадки и имени, а не от времени", () => {
  assert.equal(entryId("threads", "Priemka"), entryId("threads", "priemka"));
  assert.notEqual(entryId("threads", "priemka"), entryId("vk", "priemka"));
  assert.match(entryId("threads", "приёмка"), /^[0-9a-f]{16}$/);
});

test("отпечаток содержимого не меняется от переноса слота, отпечаток записи меняется", () => {
  const a = normalize(thread());
  const b = normalize(thread({ time: "20:30" }));
  assert.equal(contentHash(a), contentHash(b));
  assert.notEqual(entryHash(a), entryHash(b));
});

test("validate: годная ветка проходит", () => {
  assert.deepEqual(validate(normalize(thread())), []);
});

test("validate: ветка в YouTube, длинная реплика, кривая дата, файл с диска", () => {
  assert.match(validate(normalize(thread({ channel: "youtube" }))).join("|"), /вид «thread»/);
  assert.match(validate(normalize(thread({ posts: ["а".repeat(501)] }))).join("|"), /предел 500/);
  assert.match(validate(normalize(thread({ date: "15.10.2026" }))).join("|"), /дата и время/);
  const reel = normalize({ channel: "instagram", kind: "reel", name: "r1", material: "video:1", date: "2026-10-15", time: "18:30", text: "подпись", media: [{ type: "video", url: "D:/video/1.mp4" }] });
  assert.match(validate(reel).join("|"), /публичный адрес/);
});

test("validate: запись без material не принимается", () => {
  assert.match(validate(normalize(thread({ material: "" }))).join("|"), /material/);
});

test("таблица переходов: выпуск только из одобренного, из вышедшего пути нет", () => {
  assert.equal(canMove("draft", "review"), true);
  assert.equal(canMove("draft", "approved"), false);
  assert.equal(canMove("review", "approved"), true);
  assert.equal(canMove("approved", "running"), true);
  assert.equal(canMove("published", "draft"), false);
  assert.equal(canMove("running", "cancelled"), false);
});

test("preview обрезает длинное начало", () => {
  assert.ok(preview(normalize(thread()), 20).length <= 20);
});

test("nextSlot: берёт ближайший свободный, пропускает занятые и полный день", () => {
  const cfg = { slots: ["08:30", "19:00"], perDay: 2 };
  const after = Date.parse("2026-10-15T09:00:00+03:00");
  assert.deepEqual(nextSlot(cfg, [], after), { date: "2026-10-15", time: "19:00" });
  const taken = [{ id: "x", date: "2026-10-15", time: "19:00", status: "approved" }];
  assert.deepEqual(nextSlot(cfg, taken, after), { date: "2026-10-16", time: "08:30" });
  const full = [{ id: "a", date: "2026-10-15", time: "08:30", status: "published" }, { id: "b", date: "2026-10-15", time: "12:00", status: "approved" }];
  assert.deepEqual(nextSlot(cfg, full, after), { date: "2026-10-16", time: "08:30" });
  // снятая запись слот не занимает
  assert.deepEqual(nextSlot(cfg, [{ id: "c", date: "2026-10-15", time: "19:00", status: "cancelled" }], after), { date: "2026-10-15", time: "19:00" });
});

test("хранилище: создание, согласование, выпуск", async () => {
  const { entry, result } = await store.put(thread(), "S1");
  assert.equal(result, "создана");
  assert.equal(entry.status, "draft");
  await store.transition(entry.id, "review", {}, "S1");
  await store.transition(entry.id, "approved", { approval: { by: 1, name: "Анна" } }, "tg:1");
  await store.transition(entry.id, "running", { attempts: 1 }, "выпуск");
  const done = await store.transition(entry.id, "published", { result: { link: "https://threads.net/x" } }, "выпуск");
  assert.equal(done.status, "published");
  assert.equal(store.get(entry.id).result.link, "https://threads.net/x");
  assert.equal(store.history(entry.id).length, 5);
});

test("хранилище: недопустимый переход — отказ по правилу", async () => {
  const { entry } = await store.put(thread({ name: "bez-soglasovaniya" }), "S1");
  await assert.rejects(() => store.transition(entry.id, "running", {}, "выпуск"), (e) => e.code === "RULE");
});

test("хранилище: правка текста после «да» возвращает запись в черновики", async () => {
  const { entry } = await store.put(thread({ name: "pravka-posle-da" }), "S1");
  await store.transition(entry.id, "review", {}, "S1");
  await store.transition(entry.id, "approved", { approval: { by: 1 } }, "tg:1");
  const again = await store.put(thread({ name: "pravka-posle-da", posts: ["Другой текст первой реплики.", "И второй."] }), "S1");
  assert.equal(again.result, "возвращена в черновики");
  assert.equal(again.entry.status, "draft");
  assert.equal(again.entry.approval, undefined);
});

test("хранилище: перенос слота согласование не снимает", async () => {
  const { entry } = await store.put(thread({ name: "perenos-slota" }), "S1");
  await store.transition(entry.id, "review", {}, "S1");
  await store.transition(entry.id, "approved", { approval: { by: 1 } }, "tg:1");
  const moved = await store.reschedule(entry.id, "2026-10-16", "08:30", "S1");
  assert.equal(moved.status, "approved");
  assert.equal(moved.time, "08:30");
});

test("хранилище: вышедшую запись заменить нельзя", async () => {
  await assert.rejects(() => store.put(thread(), "S1"), (e) => e.code === "RULE" && /вышла/.test(e.message));
});

test("хранилище: частично вышедшую ветку заменить нельзя", async () => {
  const { entry } = await store.put(thread({ name: "oborvalas" }), "S1");
  await store.transition(entry.id, "review", {}, "S1");
  await store.transition(entry.id, "approved", {}, "tg:1");
  await store.transition(entry.id, "running", { attempts: 1 }, "выпуск");
  await store.transition(entry.id, "failed", { done: ["111"] }, "выпуск");
  await assert.rejects(() => store.put(thread({ name: "oborvalas", posts: ["новое начало", "хвост"] }), "S1"), /задвоит/);
});

test("хранилище: сжатие оставляет по одной строке на запись", async () => {
  const before = store.all().length;
  const kept = await store.compact();
  assert.equal(kept, before);
  assert.equal(store.all().length, before);
});
