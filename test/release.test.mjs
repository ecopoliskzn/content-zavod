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
  return new Response(JSON.stringify({ ok: true, result: { message_id: ++messageId, chat: { id: -1001 },...(method==='sendVideo'?{video:{file_id:'synthetic'}}:{}) } }), { status: 200 });
};

const store = await import("../src/queue/store.mjs");
const {config}=await import('../src/lib/config.mjs');config().release.mode='scheduled';
const { submit, handleCallback, handleReply, inbox } = await import("../src/bot/approval.mjs");
const { runOnce, morning, digest } = await import("../src/queue/runner.mjs");
const { _setAdapter } = await import("../src/channels/index.mjs");
const ledger = await import("../src/queue/ledger.mjs");
const { dueAt } = await import("../src/lib/time.mjs");

let behaviour = () => ({ ok: true, id: "root-1", link: "https://www.threads.net/@eco/post/1", done: ["root-1", "r-2"],messageIds:['root-1','r-2'],mediaGroupId:'synthetic-group' });
const calls = [];
_setAdapter("threads", { name: "threads", publish: async (entry, ctx) => { calls.push({ name: entry.name, verify: ctx.verify }); return behaviour(entry, ctx); } });

const SLOT = { date: "2030-03-12", time: "19:00" }; // вторник, вечер: не ночь
const at = (min) => dueAt(SLOT) + min * 60_000;
const thread = (name, over = {}) => ({
  channel: "threads", kind: "thread", name, material: "blog:primer", ...SLOT,
  posts: [`«${name}»: подрядчик в Казани сдал площадку, а через год она крошится.`, "Причина нашлась в акте: толщину никто не мерил."], ...over,timing:{mode:'at',date:over.date||SLOT.date,time:over.time||SLOT.time},
});
const press = (data, from = 42) => {const e=store.get(data.split(':')[2]),token=e?.approval?.actionToken;return handleCallback({ id: "cb", data:token?data+':'+token:data, from: { id: from, first_name: "Анна" },message:{message_id:e?.approval?.card?.messageId,chat:{id:-1001}} });};

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
  assert.match(card.body.text, /Threads · Ветка/);
  assert.doesNotMatch(card.body.text, /ограниченным доступом/);
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
  assert.deepEqual(e.result.messageIds,['root-1','r-2']);
  assert.deepEqual(ledger.rows().find(r=>r.id===id && r.status==='published').externalIds,['root-1','r-2']);
  assert.equal(ledger.rows().find(r=>r.id===id && r.status==='published').mediaGroupId,'synthetic-group');
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
  const handled = await handleReply({ text: "Уберите слово «крошится», клиент обидится",chat:{id:-1001}, from: { id: 42, first_name: "Анна" }, reply_to_message: { message_id: review.approval.card.messageId } });
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
  assert.match(card.body.text, /YouTube · Ответ на комментарий/);
  assert.match(card.body.text, /Какая толщина нужна под качели\?/);
  await press(`q:ok:${entry.id}`);
  assert.deepEqual({ date: store.get(entry.id).date, time: store.get(entry.id).time }, slot, "ответ в сетку площадки не переставляется");

  sent.length = 0;
  calls.length = 0;
  const run = await runOnce({ now: dueAt(slot) + 60_000 });
  // Ответ ушёл сотруднику, а не на площадку: это «передано», публикацией он станет по кнопке.
  assert.ok(run.handed.includes("otvet-kacheli"));
  assert.ok(!run.published.includes("otvet-kacheli"));
  assert.equal(store.get(entry.id).status, "handed");
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
  assert.equal(store.get(entry.id).status, "published", "«Отвечено» делает запись вышедшей");
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

test("пакет на ручную выкладку: «передано», а не «вышло»; публикацией его делает кнопка «Выложено»", async () => {
  const staff = await import("../src/bot/staff.mjs");
  _setAdapter("dzen", { name: "dzen", publish: async (entry, ctx) => { await ctx.onState({ packageMessageId: 7001 }); return { ok: true, manual: true, note: "пакет отправлен в группу" }; } });
  const slot = { date: "2030-03-21", time: "11:00" };
  const text = "Примыкания относятся к самым уязвимым местам резинового покрытия. ".repeat(14);
  const { entry } = await store.put({ channel: "dzen", kind: "article", name: "paket-dzen", material: "blog:primer", ...slot,timing:{mode:'at',...slot}, title: "Где покрытие отслаивается чаще всего", text }, "S1");
  await submit(entry.id, "S1");
  await press(`q:ok:${entry.id}`);
  const run = await runOnce({ now: dueAt(slot) + 60_000 });
  assert.deepEqual(run.handed, ["paket-dzen"]);
  assert.deepEqual(run.published, [], "отправленный человеку пакет вышедшим не считается");
  assert.equal(store.get(entry.id).status, "handed");
  assert.deepEqual(ledger.rows().filter((r) => r.id === entry.id).map((r) => r.status), ["handed"]);
  // Потолок площадки пакет не съедает: в журнале нет строки «вышло».
  assert.equal(ledger.published({ channel: "dzen" }).length, 0);

  // Итог дня: «вышло 0», пакет стоит отдельной строкой, а не в «не вышло».
  const day = digest(store.all(), dueAt(slot) + 11 * 3600_000);
  assert.match(day, /Итог 21\.03: вышло 0 из 1/);
  assert.match(day, /Переданы на ручную выкладку, отметки «Выложено» нет: \d/);
  assert.doesNotMatch(day, /Не вышло/);
  // И на следующее утро он всё ещё напоминает о себе.
  assert.match(morning(store.all(), dueAt({ date: "2030-03-22", time: "08:00" })), /Переданы на ручную выкладку/);

  // Править текст пакета, который уже у сотрудника, нельзя.
  await assert.rejects(() => store.put({ channel: "dzen", kind: "article", name: "paket-dzen", material: "blog:primer", ...slot, title: "Другой заголовок", text }, "S1"), (e) => e.code === "RULE" && /уже у сотрудника/.test(e.message));

  const cb = { id: "cb", data: `d:done:${entry.id}`, from: { id: 42, first_name: "Анна" }, message: { chat: { id: -1001 }, message_id: 7001, text: "пакет" } };
  await staff.handleCallback(cb);
  assert.equal(store.get(entry.id).status, "published");
  assert.equal(ledger.published({ channel: "dzen" }).length, 1);
  // Второе нажатие ничего не задваивает.
  await staff.handleCallback(cb);
  assert.equal(ledger.published({ channel: "dzen" }).length, 1);
});

test("ролик YouTube с датой выхода: «Отозвать», «Снять» и остановка выпуска снимают срок, о неудаче бот говорит прямо", async () => {
  const staff = await import("../src/bot/staff.mjs");
  const schedule = await import("../src/video/schedule.mjs");
  const { setStop, clearStop, stopState } = await import("../src/queue/switch.mjs");
  const yt = { publishAt: "", fail: false, calls: [] };
  schedule._setApi({
    status: async (id) => ({ kind: "ok", privacy: "private", publishAt: yt.publishAt, raw: { id, status: { privacyStatus: "private" } } }),
    setSchedule: async (video, publishAt) => { yt.calls.push(publishAt); if (yt.fail) return { ok: false, error: "квота исчерпана" }; yt.publishAt = publishAt; return { ok: true }; },
  });
  const slot = { date: "2030-04-02", time: "15:00",timing:{mode:'at',date:'2030-04-02',time:'15:00'} };
  const iso = new Date(dueAt(slot)).toISOString();
  const { entry } = await store.put({ channel: "youtube", kind: "short", name: "rolik-so-srokom", material: "blog:primer", ...slot, title: "Вместо нового асфальта под площадкой уложили выравнивающий слой", text: "Основание под площадкой было неровным.", media: [{ type: "video", url: "https://s3.example.ru/rolik.mp4" }], hashtags: ["покрытие"] }, "S2");
  await submit(entry.id, "S2");
  await press(`q:ok:${entry.id}`);
  // Ролик загружен с компьютера оператора со сроком выхода из слота.
  yt.publishAt = iso;
  await store.patch(entry.id, { extra: { youtubeId: "abcdefghijk", youtubePublishAt: iso, youtubeHash: store.get(entry.id).contentHash } }, "S2");
  const saved = () => store.get(entry.id).extra.youtubePublishAt;

  sent.length = 0;
  await press(`q:undo:${entry.id}`);
  assert.equal(store.get(entry.id).status, "review");
  assert.equal(yt.publishAt, "", "согласие отозвано: срок с ролика снят");
  assert.equal(saved(), "");
  assert.match(sent.map((s) => s.body.text || "").join("\n"), /Срок выхода на YouTube снят: ролик остаётся закрытым/);

  // Снова «да»: срок возвращается на ролик.
  await press(`q:ok:${entry.id}`);
  assert.equal(yt.publishAt, iso);
  assert.equal(saved(), iso);

  // Остановка выпуска человеком снимает срок со всех роликов, включение возвращает.
  sent.length = 0;
  await staff.handleCommand({ text: "/stop_release", chat: { id: -1001 }, from: { id: 42, first_name: "Анна" } });
  assert.equal(yt.publishAt, "");
  assert.match(sent.at(-1).body.text, /Срок выхода на YouTube снят у роликов: 1/);
  await staff.handleCommand({ text: "/start_release", chat: { id: -1001 }, from: { id: 42, first_name: "Анна" } });
  assert.equal(yt.publishAt, iso);
  assert.equal(stopState().stopped, false);

  // Остановка ради перехвата: срок не трогаем, а команда из группы выпуск не включает.
  setStop({ by: "оператор", reason: "перехват", takeover: true });
  yt.calls.length = 0;
  sent.length = 0;
  await staff.handleCommand({ text: "/start_release", chat: { id: -1001 }, from: { id: 42, first_name: "Анна" } });
  assert.equal(stopState().stopped, true, "остановку ради перехвата снимает только возврат расписания");
  assert.match(sent.at(-1).body.text, /Включить выпуск сейчас нельзя/);
  assert.deepEqual(yt.calls, [], "сервер уступил расписание: сроки роликов не трогаются");
  assert.equal(yt.publishAt, iso);
  clearStop({ all: true });

  // YouTube отказал: «не выйдет» не говорится, человек получает действие.
  yt.fail = true;
  sent.length = 0;
  await press(`q:no:${entry.id}`);
  assert.equal(store.get(entry.id).status, "cancelled");
  assert.equal(saved(), iso, "срок остался на ролике, и завод это помнит");
  const all = sent.map((s) => s.body.text || "").join("\n");
  assert.match(all, /снять не удалось/);
  assert.match(all, /Студия YouTube/);
  assert.doesNotMatch(all, /Не выйдет\./);

  // Следующий проход выпуска повторяет попытку сам.
  yt.fail = false;
  await runOnce({ now: Date.now() });
  assert.equal(yt.publishAt, "");
  assert.equal(saved(), "");
  schedule._setApi(null);
});

test("ролик YouTube, который открылся сам за время простоя, не объявляется невышедшим", async () => {
  // Слот утренний: проход через семь часов не должен попасть на вечернюю сводку со сжатием журнала.
  const slot = { date: "2030-04-09", time: "10:00" };
  const link = "https://www.youtube.com/watch?v=zzzzzzzzzzz";
  _setAdapter("youtube", { name: "youtube", already: async () => ({ id: "zzzzzzzzzzz", link }), publish: async () => ({ ok: false, error: "не должно вызываться", retry: false }) });
  const { entry } = await store.put({ channel: "youtube", kind: "short", name: "otkrylsya-sam", material: "blog:primer", ...slot, title: "На площадке режем покрытие до основания", text: "Толщину по внешнему виду не оценить.", media: [{ type: "video", url: "https://s3.example.ru/sam.mp4" }], hashtags: ["покрытие"] }, "S2");
  await submit(entry.id, "S2");
  await press(`q:ok:${entry.id}`);
  const run = await runOnce({ now: dueAt(slot) + 7 * 3600_000 });
  assert.deepEqual(run.expired, []);
  assert.ok(run.published.includes("otkrylsya-sam"));
  assert.equal(store.get(entry.id).status, "published");
  assert.equal(store.get(entry.id).result.link, link);
});

test("загруженный ролик YouTube проверяется заранее: застава в минуту слота опоздала бы", async () => {
  const schedule = await import("../src/video/schedule.mjs");
  const yt = { publishAt: "", calls: [] };
  schedule._setApi({
    status: async (id) => ({ kind: "ok", privacy: "private", publishAt: yt.publishAt, raw: { id, status: { privacyStatus: "private" } } }),
    setSchedule: async (video, publishAt) => { yt.calls.push(publishAt); yt.publishAt = publishAt; return { ok: true }; },
  });
  const slot = { date: "2030-04-16", time: "15:00" };
  const iso = new Date(dueAt(slot)).toISOString();
  // Запись одобрили, пока приём заявок был открыт: в ней ссылка в бота. Потом приём закрылся
  // (в тестах он закрыт: согласия в проекте не утверждены), а ролик уже лежит на YouTube со сроком.
  const { entry } = await store.put({ channel: "youtube", kind: "short", name: "rolik-s-botom", material: "blog:primer", ...slot, title: "Покрытие вырезали до основания при заказчике", text: "Толщину по внешнему виду не оценить.", media: [{ type: "video", url: "https://s3.example.ru/bot.mp4" }], hashtags: ["покрытие"], botKey: "priemka" }, "S2");
  await store.transition(entry.id, "review", {}, "S2");
  await store.transition(entry.id, "approved", { approval: { by: 42, name: "Анна", at: new Date().toISOString() } }, "tg:42");
  await store.patch(entry.id, { extra: { youtubeId: "bbbbbbbbbbb", youtubePublishAt: iso, youtubeHash: store.get(entry.id).contentHash } }, "S2");
  yt.publishAt = iso;

  sent.length = 0;
  // До слота ещё далеко: обычная застава сработала бы только в минуту слота, когда YouTube уже открыл ролик.
  const run = await runOnce({ now: Date.now() });
  assert.deepEqual(run.published, []);
  assert.equal(store.get(entry.id).status, "review", "согласие снято заранее");
  assert.equal(yt.publishAt, "", "и срок с ролика убран, пока до него есть время");
  assert.equal(store.get(entry.id).extra.youtubePublishAt, "");
  const alarm = sent.map((s) => s.body.text || "").join("\n");
  assert.match(alarm, /проверка перед выпуском не пустила/);
  assert.match(alarm, /приём заявок закрыт/);
  schedule._setApi(null);
});

test("ролик на другой площадке ждёт премьеры на YouTube, даже если его слот уже наступил", async () => {
  const day = { date: "2030-04-23" };
  let rutubeCalls = 0;
  _setAdapter("rutube", { name: "rutube", publish: async () => { rutubeCalls++; return { ok: true, id: "rt1", link: "https://rutube.ru/video/rt1/" }; } });
  let youtubeReady = false;
  _setAdapter("youtube", { name: "youtube", publish: async () => (youtubeReady ? { ok: true, id: "ccccccccccc", link: "https://www.youtube.com/watch?v=ccccccccccc" } : { ok: false, error: "ролик не загружен на YouTube", retry: true }) });
  const base = { material: "blog:primer", title: "Толщину покрытия проверили вырубкой при заказчике", text: "Толщину по внешнему виду не оценить.", media: [{ type: "video", url: "https://s3.example.ru/p.mp4" }], hashtags: ["покрытие"] };
  const yt = (await store.put({ channel: "youtube", kind: "short", name: "zhdet-premery", ...day, time: "10:00",timing:{mode:'at',...day,time:'10:00'}, ...base }, "S2")).entry;
  const rt = (await store.put({ channel: "rutube", kind: "short", name: "zhdet-premery", ...day, time: "10:10",timing:{mode:'at',...day,time:'10:10'}, ...base }, "S2")).entry;
  for (const e of [yt, rt]) { await submit(e.id, "S2"); await press(`q:ok:${e.id}`); }
  // 10:15: слот Rutube наступил, а премьера на YouTube не состоялась.
  const first = await runOnce({ now: dueAt({ ...day, time: "10:15" }) });
  assert.ok(first.waiting.includes("zhdet-premery"));
  assert.equal(rutubeCalls, 0, "Rutube раньше YouTube не выходит");
  assert.equal(store.get(rt.id).status, "approved");
  // Ролик загрузили, YouTube вышел: следующий проход отпускает и Rutube.
  youtubeReady = true;
  await runOnce({ now: dueAt({ ...day, time: "10:20" }) });
  assert.equal(store.get(yt.id).status, "published");
  await runOnce({ now: dueAt({ ...day, time: "10:25" }) });
  assert.equal(store.get(rt.id).status, "published");
  assert.equal(rutubeCalls, 1);
});

test("«Одобрить» под устаревшей карточкой не одобряет текст, которого утверждающий не читал", async () => {
  const { execute } = await import("../src/queue/commands.mjs");
  const raw = thread("kartochka-dvazhdy", { date: "2030-04-30", time: "14:30" });
  const { entry } = await store.put(raw, "S1");
  const first = await submit(entry.id, "S1");
  const oldCard = first.approval.card.messageId;
  // Оператор поправил текст, пока запись ждала «да», и отправил заново: в теме две карточки.
  sent.length = 0;
  const edited = await execute("add", { entries: [{ ...raw, posts: ["«kartochka-dvazhdy»: второй текст, его под первой карточкой не было.", "Причина нашлась в акте: толщину никто не мерил."] }] }, "S1");
  assert.match(edited.lines.join("\n"), /возвращена в черновики/);
  assert.match(edited.lines.join("\n"), /прежняя карточка в рабочей группе снята/);
  const retired = sent.find((s) => s.method === "editMessageText" && s.body.message_id === oldCard);
  assert.ok(retired, "с прежней карточки сняты кнопки");
  assert.match(retired.body.text, /эта карточка больше не действует/);
  assert.deepEqual(retired.body.reply_markup, { inline_keyboard: [] });
  const second = await submit(entry.id, "S1");
  const newCard = second.approval.card.messageId;
  assert.notEqual(newCard, oldCard);

  const tap = (data, messageId) => {const token=store.get(data.split(':')[2])?.approval?.actionToken;return handleCallback({ id: "cb", data:token?data+':'+token:data, from: { id: 42, first_name: "Анна" }, message: { message_id: messageId, chat: { id: -1001 } } });};
  sent.length = 0;
  await tap(`q:ok:${entry.id}`, oldCard);
  assert.equal(store.get(entry.id).status, "review", "нажатие под первой карточкой согласием не стало");
  assert.match(sent.find((s) => s.method === "answerCallbackQuery").body.text, /карточка устарела/);
  await tap(`q:fix:${entry.id}`, oldCard);
  assert.equal(store.get(entry.id).fixAsked, undefined, "и просьбой о правке тоже");
  // Под текущей карточкой решение принимается как обычно.
  await tap(`q:ok:${entry.id}`, newCard);
  assert.equal(store.get(entry.id).status, "approved");
  // Старая карточка не снимает новую версию; актуальная кнопка снимает только её.
  await tap(`q:no:${entry.id}`, oldCard);
  assert.equal(store.get(entry.id).status, "approved");
  await tap(`q:no:${entry.id}`, newCard);
  assert.equal(store.get(entry.id).status, "cancelled");
});
