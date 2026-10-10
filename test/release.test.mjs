// Согласование и выпуск: от черновика до журнала. Сеть подменена, площадка — заглушка.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = mkdtempSync(path.join(os.tmpdir(), "zavod-release-"));
process.env.DATA_DIR = DATA;
process.env.ZAVOD_ENV_FILE = path.join(DATA, "нет-такого.env");
process.env.TG_BOT_TOKEN = "test-token";
process.env.TG_GROUP_ID = "-1001";
process.env.APPROVER_IDS = "42";
delete process.env.TG_RELAY_URL;

// Подмена Telegram: запоминаем вызовы, отвечаем успехом.
const sent = [];
let messageId = 100;
globalThis.fetch = async (url, init) => {
  const method = String(url).split("/").pop();
  const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : {};
  sent.push({ method, body });
  return new Response(JSON.stringify({ ok: true, result: { message_id: ++messageId, chat: { id: -1001 } } }), { status: 200 });
};

const store = await import("../src/queue/store.mjs");
const { submit, handleCallback, handleReply, inbox } = await import("../src/bot/approval.mjs");
const { runOnce, morning, digest } = await import("../src/queue/runner.mjs");
const { _setAdapter } = await import("../src/channels/index.mjs");
const ledger = await import("../src/queue/ledger.mjs");
const { dueAt } = await import("../src/lib/time.mjs");

let behaviour = () => ({ ok: true, id: "root-1", link: "https://www.threads.net/@eco/post/1", done: ["root-1", "r-2"] });
const calls = [];
_setAdapter("threads", { name: "threads", publish: async (entry, ctx) => { calls.push({ name: entry.name, verify: ctx.verify }); return behaviour(entry, ctx); } });

const SLOT = { date: "2030-03-12", time: "19:00" }; // вторник, вечер: не ночь
const at = (min) => dueAt(SLOT) + min * 60_000;
const thread = (name, over = {}) => ({
  channel: "threads", kind: "thread", name, material: "blog:primer", ...SLOT,
  posts: [`«${name}»: подрядчик в Казани сдал площадку, а через год она крошится.`, "Причина нашлась в акте: толщину никто не мерил."], ...over,
});
const press = (data, from = 42) => handleCallback({ id: "cb", data, from: { id: from, first_name: "Анна" } });

test("на согласование уходит только то, что прошло проверки", async () => {
  const { entry } = await store.put(thread("s-zaglushkoj", { posts: ["Покрытие в Казани служит [здесь срок] лет", "хвост"] }), "S1");
  await assert.rejects(() => submit(entry.id), (e) => e.code === "RULE" && /заглушка/.test(e.message));
  assert.equal(store.get(entry.id).status, "draft");
});

test("карточка уходит в группу с кнопками, запись ждёт согласования", async () => {
  const { entry } = await store.put(thread("put-do-vyhoda"), "S1");
  sent.length = 0;
  const review = await submit(entry.id, "S1");
  assert.equal(review.status, "review");
  assert.ok(review.approval.card.messageId);
  const card = sent.find((s) => s.method === "sendMessage");
  assert.match(card.body.text, /На согласование · Threads/);
  assert.match(card.body.text, /ограниченным доступом/);
  assert.equal(card.body.reply_markup.inline_keyboard[0].length, 3);
});

test("нажатие постороннего согласием не считается", async () => {
  const id = store.all().find((e) => e.name === "put-do-vyhoda").id;
  await press(`q:ok:${id}`, 7);
  assert.equal(store.get(id).status, "review");
});

test("одобрение записывает, кто и когда сказал «да»", async () => {
  const id = store.all().find((e) => e.name === "put-do-vyhoda").id;
  await press(`q:ok:${id}`);
  const e = store.get(id);
  assert.equal(e.status, "approved");
  assert.equal(e.approval.by, 42);
  assert.equal(e.approval.name, "Анна");
});

test("выпуск: до слота тихо, после слота запись выходит и попадает в журнал", async () => {
  const id = store.all().find((e) => e.name === "put-do-vyhoda").id;
  calls.length = 0;
  const early = await runOnce({ now: at(-10) });
  assert.deepEqual(early.published, []);
  const run = await runOnce({ now: at(1) });
  assert.deepEqual(run.published, ["put-do-vyhoda"]);
  const e = store.get(id);
  assert.equal(e.status, "published");
  assert.equal(e.result.link, "https://www.threads.net/@eco/post/1");
  assert.equal(ledger.rows().filter((r) => r.id === id && r.status === "published").length, 1);
  // повторный проход ту же запись не трогает
  await runOnce({ now: at(6) });
  assert.equal(calls.filter((c) => c.name === "put-do-vyhoda").length, 1);
});

test("черновик и запись без «да» не выходят никогда", async () => {
  const a = (await store.put(thread("tolko-chernovik"), "S1")).entry;
  const b = (await store.put(thread("zhdet-da"), "S1")).entry;
  await submit(b.id);
  const run = await runOnce({ now: at(200) });
  assert.ok(!run.published.includes("tolko-chernovik") && !run.published.includes("zhdet-da"));
  assert.equal(store.get(a.id).status, "draft");
  assert.equal(store.get(b.id).status, "review");
  await press(`q:no:${b.id}`);
  assert.equal(store.get(b.id).status, "cancelled");
});

test("правка: ответ на карточку возвращает запись оператору с текстом замечания", async () => {
  const { entry } = await store.put(thread("na-pravku"), "S1");
  const review = await submit(entry.id);
  await press(`q:fix:${entry.id}`);
  const handled = await handleReply({ text: "Уберите слово «крошится», клиент обидится", from: { id: 42, first_name: "Анна" }, reply_to_message: { message_id: review.approval.card.messageId } });
  assert.equal(handled, true);
  assert.equal(store.get(entry.id).status, "rework");
  assert.match(inbox().find((x) => x.id === entry.id).note, /обидится/);
});

test("сбой площадки: три попытки, потом ошибка и тревога с действием", async () => {
  const { entry } = await store.put(thread("ne-vyshla", { date: "2030-03-13" }), "S1");
  await submit(entry.id);
  await press(`q:ok:${entry.id}`);
  behaviour = () => ({ ok: false, error: "площадка не приняла текст: сеть", retry: true, done: [] });
  const base = dueAt({ date: "2030-03-13", time: "19:00" });
  sent.length = 0;
  const r1 = await runOnce({ now: base + 60_000 });
  assert.deepEqual(r1.retry, ["ne-vyshla"]);
  await runOnce({ now: base + 6 * 60_000 });
  const r3 = await runOnce({ now: base + 11 * 60_000 });
  assert.deepEqual(r3.failed, ["ne-vyshla"]);
  assert.equal(store.get(entry.id).status, "failed");
  const alarm = sent.find((s) => s.method === "sendMessage" && /Что сделать/.test(s.body.text));
  assert.ok(alarm, "тревога обязана нести действие");
  // повторы шли со сверкой с площадкой
  assert.deepEqual(calls.filter((c) => c.name === "ne-vyshla").map((c) => c.verify), [false, true, true]);
  behaviour = () => ({ ok: true, id: "root-2", link: "https://www.threads.net/@eco/post/2", done: ["root-2"] });
});

test("просроченная больше шести часов не выходит, человеку уходит кнопка", async () => {
  const { entry } = await store.put(thread("opozdala", { date: "2030-03-14" }), "S1");
  await submit(entry.id);
  await press(`q:ok:${entry.id}`);
  sent.length = 0;
  const run = await runOnce({ now: dueAt({ date: "2030-03-14", time: "19:00" }) + 7 * 3600_000 });
  assert.deepEqual(run.expired, ["opozdala"]);
  assert.equal(store.get(entry.id).status, "expired");
  assert.match(JSON.stringify(sent.at(-1).body.reply_markup), /q:next:/);
  await press(`q:next:${entry.id}`);
  assert.equal(store.get(entry.id).status, "approved");
});

test("после простоя опоздавшие идут по одной, а не пачкой", async () => {
  const day = { date: "2030-03-19" };
  const a = (await store.put(thread("dogon-1", { ...day, time: "14:30" }), "S1")).entry;
  const b = (await store.put(thread("dogon-2", { ...day, time: "19:00" }), "S1")).entry;
  for (const e of [a, b]) { await submit(e.id); await press(`q:ok:${e.id}`); }
  // сервер «проснулся» в 20:00: обе опоздали
  const now = dueAt({ ...day, time: "20:00" });
  const run = await runOnce({ now });
  assert.deepEqual(run.published, ["dogon-1"]);
  assert.deepEqual(run.waiting, ["dogon-2"]);
});

test("ответ на комментарий: уходит сотруднику без ожидания слота, «Отвечено» закрывает комментарий", async () => {
  const comments = await import("../src/comments/collect.mjs");
  const staff = await import("../src/bot/staff.mjs");
  const { appendJsonl } = await import("../src/lib/files.mjs");
  appendJsonl(path.join(DATA, "comments.jsonl"), { id: "youtube:abc", platform: "youtube", at: "2030-03-19T20:00:00.000Z", text: "Какая толщина нужна под качели?", link: "https://www.youtube.com/watch?v=x&lc=abc", status: "new" });
  const slot = { date: "2030-03-20", time: "03:10" }; // ночь: обычную запись выпуск бы придержал до утра
  const text = "Под качели слой считают по высоте падения: чем выше сиденье, тем он толще.";
  const { entry } = await store.put({ channel: "youtube", kind: "reply", name: "otvet-kacheli", material: "comment:youtube:abc", ...slot, text, link: "https://www.youtube.com/watch?v=x&lc=abc", context: "Какая толщина нужна под качели?" }, "S6");
  sent.length = 0;
  await submit(entry.id, "S6");
  const card = sent.find((s) => s.method === "sendMessage");
  assert.match(card.body.text, /ответ на комментарий · YouTube/);
  assert.match(card.body.text, /Какая толщина нужна под качели\?/);
  await press(`q:ok:${entry.id}`);
  assert.deepEqual({ date: store.get(entry.id).date, time: store.get(entry.id).time }, slot, "ответ в сетку площадки не переставляется");

  sent.length = 0;
  calls.length = 0;
  const run = await runOnce({ now: dueAt(slot) + 60_000 });
  assert.ok(run.published.includes("otvet-kacheli"));
  const pack = sent.find((s) => /Ответить на комментарий/.test(s.body.text || ""));
  assert.ok(pack, "сотрудник получает пакет: ссылка на комментарий и что сделать");
  assert.match(pack.body.text, /lc=abc/);
  assert.equal(pack.body.reply_markup.inline_keyboard[0][0].callback_data, `d:done:${entry.id}`);
  assert.ok(sent.some((s) => s.body.text === text), "текст ответа идёт отдельным сообщением: его копируют целиком");
  assert.equal(calls.length, 0, "на площадку завод сам ничего не пишет");
  // В журнале ответ не считается публикацией: потолок площадки он не съедает.
  assert.deepEqual(ledger.rows().filter((r) => r.id === entry.id).map((r) => r.status), ["handed"]);
  assert.equal(ledger.published({ channel: "youtube" }).length, 0);

  await staff.handleCallback({ id: "cb", data: `d:done:${entry.id}`, from: { id: 42, first_name: "Анна" }, message: { chat: { id: -1001 }, message_id: 5, text: "пакет" } });
  assert.deepEqual(comments.byStatus("answered").map((c) => c.id), ["youtube:abc"]);
  assert.equal(comments.byStatus("new").length, 0);
  assert.ok(ledger.rows().some((r) => r.id === entry.id && r.status === "replied"));
  assert.equal(comments.setStatus("нет-такого", "skipped"), false);
});

test("файл STOP останавливает выпуск целиком", async () => {
  writeFileSync(path.join(DATA, "STOP"), "перехват");
  const run = await runOnce({ now: at(500) });
  assert.equal(run.stopped, true);
  rmSync(path.join(DATA, "STOP"));
  assert.equal(existsSync(path.join(DATA, "STOP")), false);
});

test("утренний план и вечерняя сводка собираются из очереди", () => {
  const e = (name, status, over = {}) => ({ id: name, channel: "threads", kind: "thread", name, ...SLOT, posts: [`Начало ветки ${name}`], status, ...over });
  const entries = [
    e("vyshla", "published", { time: "08:30", result: { link: "https://www.threads.net/@eco/post/9" } }),
    e("odobrena", "approved"),
    e("zhdet", "review", { time: "20:30" }),
    e("zavtra", "approved", { date: "2030-03-13" }),
    e("snyata", "cancelled"),
  ];
  const plan = morning(entries, at(-600));
  assert.match(plan, /План на 12\.03: одобрено 1, ждёт согласования 1/);
  assert.match(plan, /Ждут «да» сегодня/);
  const day = digest(entries, at(180));
  assert.match(day, /Итог 12\.03: вышло 1 из 3/);
  assert.match(day, /Не вышло/);
  assert.match(day, /Завтра в очереди: 1/);
  assert.doesNotMatch(day, /snyata/);
});
