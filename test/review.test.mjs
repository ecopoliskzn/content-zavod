// То, что нашла вычитка завода 10.10.2026. Каждый тест держит один найденный случай:
// что было не так, записано в docs/05-ГРАБЛИ.md, раздел «Сборка этого завода».
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = mkdtempSync(path.join(os.tmpdir(), "zavod-review-"));
process.env.DATA_DIR = DATA;
process.env.ZAVOD_ENV_FILE = path.join(DATA, "нет-такого.env");
process.env.TG_BOT_TOKEN = "test-token";
process.env.TG_GROUP_ID = "-1001";
process.env.APPROVER_IDS = "42";
delete process.env.TG_RELAY_URL;
delete process.env.QUEUE_API_BASE;

// Подмена Telegram: запоминаем сообщения в группу, отвечаем успехом.
const sent = [];
let messageId = 500;
globalThis.fetch = async (url, init) => {
  const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : {};
  sent.push({ method: String(url).split("/").pop(), body });
  return new Response(JSON.stringify({ ok: true, result: { message_id: ++messageId, chat: { id: -1001 } } }), { status: 200 });
};

const { adlaw, facts, intakeIn, normalNumber, numberTokensIn, ready } = await import("../src/gates/rules.mjs");
const { gridFor, nextSlot, premiereOf, slotFor, aheadOfPremiere, weekday } = await import("../src/queue/slots.mjs");
const { canMove, STATUSES, STATUS_TITLE } = await import("../src/queue/format.mjs");
const { clearStop, setStop, stopState } = await import("../src/queue/switch.mjs");
const { KEEP, wantedPublishAt } = await import("../src/video/schedule.mjs");
const { swapRelations } = await import("../src/video/series.mjs");
const { findInShowcase } = await import("../src/channels/telegram.mjs");
const { entryLabel, funnel, publicEntry, safeKey } = await import("../src/queue/snapshot.mjs");
const { atRisk, renderSchedule } = await import("../src/queue/mirror.mjs");
const { legalGaps, LEGAL_CONFIRMATIONS, LEGAL_DOCS } = await import("../src/leads/legal.mjs");
const { dueAt } = await import("../src/lib/time.mjs");
const config = (await import("../src/lib/config.mjs")).config();

const post = (text, over = {}) => ({ channel: "telegram", kind: "post", name: "p", text, ...over });

/* ── Реклама: цена словами ───────────────────────────────────────────────── */

test("реклама: цена, написанная словами, останавливает так же, как цена знаком", () => {
  const blocked = [
    "Покрытие стоит 1500 рублей за квадратный метр.",
    "Набор стоит 24 996 ₽.",
    "Цена 1 500 ₽/м².",
    "1500 р/м2 под ключ.",
    "За квадратный метр выходит 1500 рублей.",
    "Работа обошлась в 300 тысяч.",
    "Стоимость такой работы составила 300 тыс. руб.",
    "Мешок крошки отдаём за 900 рублей.",
  ];
  for (const text of blocked) assert.ok(adlaw(post(text), { restricted: true }).block.length, `должно остановить: ${text}`);
});

test("реклама: площадь, толщина и расход ценой не считаются", () => {
  const clean = [
    "На объекте уложили 14 тысяч квадратных метров покрытия.",
    "Толщина слоя 10 мм, площадь 500 м².",
    "На метр уходит 8 кг крошки.",
    "Гарантия по шаблону договора 5 лет.",
  ];
  for (const text of clean) assert.deepEqual(adlaw(post(text), { restricted: true }), { block: [], warn: [] }, `не должно задеть: ${text}`);
});

test("реклама: сумма, которая не цена товара, уходит утверждающему замечанием", () => {
  for (const text of ["Штраф для юридического лица до 500 тысяч рублей.", "Контракт на 3 млн рублей заключили в мае."]) {
    const v = adlaw(post(text), { restricted: true });
    assert.deepEqual(v.block, [], `сумму из закона и закупок не останавливаем: ${text}`);
    assert.match(v.warn.join("|"), /сумма в рублях/);
  }
  // На открытой площадке цена допустима: остаётся напоминание сверить её с сайтом.
  const open = adlaw(post("Набор стоит 24 996 ₽.", { channel: "vk" }), { restricted: false });
  assert.deepEqual(open.block, []);
  assert.match(open.warn.join("|"), /Площадка открытая/);
});

/* ── Факты: число сравнивается целиком ───────────────────────────────────── */

test("факты: «14» не подтверждается источником, в котором стоит «2014»", () => {
  const entry = (claim) => ({ kind: "post", channel: "vk", text: "На участке сделали 14 вырубок.", facts: [{ claim, source: "https://ecopolisrf.ru/x" }] });
  assert.match(facts(entry("Компания работает с 2014 года")).block.join("|"), /без источника: 14/);
  assert.match(facts(entry("площадь 140 м²")).block.join("|"), /без источника: 14/);
  assert.deepEqual(facts(entry("для объекта площадью 500 м² потребуется 14 вырубок")).block, []);
});

test("факты: «1 500» равно «1500», «2,5» равно «2.5» и не равно «25»", () => {
  assert.equal(normalNumber("1 500"), "1500");
  assert.equal(normalNumber("2,5"), "2.5");
  assert.deepEqual(numberTokensIn("слой 2.5 см; площадь 1 500 м2; 10–15 мм"), ["2.5", "1500", "10", "15"]);
  const e = { kind: "post", channel: "vk", text: "Слой 2,5 см." };
  assert.deepEqual(facts({ ...e, facts: [{ claim: "слой 2.5 см", source: "https://x" }] }).block, []);
  assert.match(facts({ ...e, facts: [{ claim: "слой 25 мм", source: "https://x" }] }).block.join("|"), /без источника: 2,5/);
});

/* ── Готовность: приём заявок закрыт ─────────────────────────────────────── */

test("готовность: пока приём закрыт, запись не зовёт ни в бота, ни на форму, ни словом", () => {
  const ctx = { legal: false, codeWords: ["ПРИЁМКА"], linkTargets: { priemka: "https://ecopolisrf.ru/blog/x/", vbota: "https://t.me/eco_bot?start=yt-priemka" } };
  const reel = { channel: "instagram", kind: "reel", name: "r", text: "Чек-лист пришлём в личные сообщения. Напишите в комментарии слово ПРИЁМКА." };
  assert.match(ready(reel, ctx).block.join("|"), /приём заявок закрыт.*кодовое слово «ПРИЁМКА»/);
  assert.match(ready({ channel: "youtube", kind: "short", name: "v", title: "т", text: "о", botKey: "priemka" }, ctx).block.join("|"), /ссылка в бота \(поле botKey/);
  assert.match(ready(post("Подробнее: https://t.me/eco_bot?start=tg-priemka"), ctx).block.join("|"), /ссылка в бота/);
  assert.match(ready(post("Заявка: https://go.ecopolisrf.ru/z/raschet?c=tg"), ctx).block.join("|"), /форму заявки/);
  assert.match(ready({ channel: "youtube", kind: "short", name: "v", title: "т", text: "о", goSlug: "vbota" }, ctx).block.join("|"), /ведёт в бота или на форму/);
  assert.match(ready({ channel: "bot", kind: "post", name: "b", text: "Новый материал." }, ctx).block.join("|"), /рассылка в боте/);
  // Ссылка на статью сайта проходит: это и есть путь, пока приём закрыт.
  assert.deepEqual(ready(post("Чек-лист: https://go.ecopolisrf.ru/go/priemka?c=tg&p=p"), ctx).block, []);
  assert.deepEqual(ready({ channel: "youtube", kind: "short", name: "v", title: "т", text: "о", goSlug: "priemka" }, ctx).block, []);
});

test("готовность: приём открыт — те же записи проходят; строчное «приёмка» словом бота не считается", () => {
  const ctx = { legal: true, codeWords: ["ПРИЁМКА"] };
  assert.deepEqual(ready({ channel: "youtube", kind: "short", name: "v", title: "т", text: "о", botKey: "priemka" }, ctx).block, []);
  assert.deepEqual(intakeIn(post("Как проходит приёмка покрытия."), { codeWords: ["ПРИЁМКА"] }), []);
});

/* ── Слоты: рабочая сетка и премьера ─────────────────────────────────────── */

test("рабочая сетка: запись без времени встаёт по дням и часам сетки, а не в первый свободный слот", () => {
  const threads = config.channels.threads;
  assert.deepEqual(gridFor(threads).slots, ["14:30", "19:00"]);
  const monday = Date.parse("2030-03-11T06:00:00+03:00"); // понедельник, утро
  assert.equal(weekday("2030-03-11"), 1);
  const taken = [];
  const got = [];
  for (let i = 0; i < 4; i++) { const s = nextSlot(threads, taken, monday); got.push(`${s.date} ${s.time}`); taken.push({ id: `t${i}`, ...s, status: "draft" }); }
  // Четыре ветки, написанные за одну сессию, расходятся на два дня: слот 08:30 в сетку не входит.
  assert.deepEqual(got, ["2030-03-11 14:30", "2030-03-11 19:00", "2030-03-12 14:30", "2030-03-12 19:00"]);

  // YouTube: вторник, четверг, суббота, 15:00.
  const yt = config.channels.youtube;
  const days = [];
  const busy = [];
  for (let i = 0; i < 3; i++) { const s = nextSlot(yt, busy, monday); days.push(`${s.date} ${s.time}`); busy.push({ id: `y${i}`, ...s, status: "draft" }); }
  assert.deepEqual(days, ["2030-03-12 15:00", "2030-03-14 15:00", "2030-03-16 15:00"]);

  // ВКонтакте: пост и ролик стоят в разных строках сетки.
  const vk = config.channels.vk;
  assert.deepEqual(nextSlot(vk, [], monday, "", "post"), { date: "2030-03-11", time: "12:00" });
  assert.deepEqual(nextSlot(vk, [], monday, "", "video"), { date: "2030-03-11", time: "18:00" });
});

test("ответ на комментарий слота не занимает и дневной потолок не съедает", () => {
  const tg = config.channels.telegram;
  const monday = Date.parse("2030-03-11T06:00:00+03:00");
  const taken = [{ id: "r1", kind: "reply", date: "2030-03-11", time: "10:00", status: "approved" }];
  assert.deepEqual(nextSlot(tg, taken, monday), { date: "2030-03-11", time: "10:00" });
});

test("ролик на других площадках встаёт после премьеры на YouTube", () => {
  const premiere = { id: "y", channel: "youtube", kind: "short", name: "vyrubki", date: "2030-03-14", time: "15:00", status: "approved" };
  const monday = Date.parse("2030-03-11T06:00:00+03:00");
  const reel = { id: "i", channel: "instagram", kind: "reel", name: "vyrubki" };
  assert.equal(premiereOf([premiere], reel), dueAt(premiere));
  // Без правила рилс встал бы в понедельник 18:30, раньше премьеры в четверг.
  assert.deepEqual(slotFor(reel, [premiere], config.channels.instagram, monday), { date: "2030-03-14", time: "18:30" });
  assert.deepEqual(slotFor({ id: "r", channel: "rutube", kind: "short", name: "vyrubki" }, [premiere], config.channels.rutube, monday), { date: "2030-03-14", time: "15:10" });
  assert.deepEqual(slotFor({ id: "v", channel: "vk", kind: "video", name: "vyrubki" }, [premiere], config.channels.vk, monday), { date: "2030-03-14", time: "18:00" });
  // Пост с тем же именем премьеры не ждёт: правило только для роликов.
  assert.equal(premiereOf([premiere], { channel: "vk", kind: "post", name: "vyrubki" }), 0);
  // Премьеру переставили позже: записи, оставшиеся раньше неё, названы.
  const early = { id: "i", channel: "instagram", kind: "reel", name: "vyrubki", date: "2030-03-13", time: "18:30", status: "approved" };
  assert.deepEqual(aheadOfPremiere([premiere, early], premiere).map((e) => e.channel), ["instagram"]);
});

/* ── Статус «передано» и рубильник с причиной ────────────────────────────── */

test("у пакета на ручную выкладку свой статус между «выходит» и «вышло»", () => {
  assert.ok(STATUSES.includes("handed"));
  assert.equal(STATUS_TITLE.handed, "передано на ручную выкладку");
  assert.ok(canMove("running", "handed") && canMove("handed", "published") && canMove("handed", "cancelled"));
  assert.ok(!canMove("approved", "handed") && !canMove("handed", "approved"));
});

test("в рубильнике две независимые отметки: слово человека и перехват друг друга не затирают", () => {
  clearStop({ all: true });
  assert.deepEqual(stopState(), { stopped: false, human: false, takeover: false, handback: false, by: "", at: "", reason: "" });
  setStop({ by: "Анна", reason: "команда /stop_release" });
  assert.deepEqual([stopState().stopped, stopState().human, stopState().takeover], [true, true, false]);
  // Перехват поверх остановки человеком: слово человека остаётся, и оно же стоит первым.
  setStop({ by: "оператор (дубль)", reason: "перехват расписания компьютером оператора", takeover: true });
  assert.deepEqual([stopState().human, stopState().takeover, stopState().by], [true, true, "Анна"]);
  // Возврат снимает только свою отметку: «стоп» человека остаётся в силе.
  assert.deepEqual([clearStop({ takeover: true }).stopped, stopState().human, stopState().takeover], [true, true, false]);
  // И обратно: «старт» человека отметку перехвата не снимает.
  setStop({ by: "оператор (дубль)", reason: "перехват", takeover: true });
  assert.deepEqual([clearStop().stopped, stopState().human, stopState().takeover], [true, false, true]);
  clearStop({ all: true });
  // Файл, положенный руками, останавливает выпуск как слово человека, и снять его можно.
  writeFileSync(path.join(DATA, "STOP"), "остановил вручную");
  assert.deepEqual([stopState().stopped, stopState().human, stopState().takeover, stopState().reason], [true, true, false, "остановил вручную"]);
  assert.equal(clearStop().stopped, false);
});

/* ── Срок выхода на YouTube следует за записью ───────────────────────────── */

test("срок на YouTube: одобрена и слот впереди — срок равен слоту; иначе срока нет", () => {
  const now = Date.parse("2030-03-11T06:00:00+03:00");
  const e = (status, over = {}) => ({ channel: "youtube", kind: "short", status, date: "2030-03-12", time: "15:00", extra: { youtubeId: "abcdefghijk" }, ...over });
  const iso = new Date(Date.parse("2030-03-12T15:00:00+03:00")).toISOString();
  assert.equal(wantedPublishAt(e("approved"), { now }), iso);
  for (const status of ["review", "rework", "draft", "cancelled", "failed", "expired"]) assert.equal(wantedPublishAt(e(status), { now }), "", `статус ${status}: срока быть не должно`);
  assert.equal(wantedPublishAt(e("approved"), { now, stopped: true }), "", "выпуск остановлен человеком");
  // Не трогаем: вышла, выходит прямо сейчас, уже открыта, до слота меньше десяти минут, ролик не загружен.
  assert.equal(wantedPublishAt(e("published"), { now }), KEEP);
  assert.equal(wantedPublishAt(e("running"), { now }), KEEP);
  assert.equal(wantedPublishAt(e("review", { extra: { youtubeId: "abcdefghijk", youtubeOpen: true } }), { now }), KEEP);
  assert.equal(wantedPublishAt(e("approved"), { now: Date.parse("2030-03-12T14:55:00+03:00") }), KEEP);
  assert.equal(wantedPublishAt(e("review", { extra: {} }), { now }), KEEP);
  assert.equal(wantedPublishAt({ ...e("review"), channel: "rutube" }, { now }), KEEP);
});

/* ── Описание старого ролика: трогаем только своё ────────────────────────── */

test("блок ссылок у старого ролика: текст клиента цел, даже если в нём есть «Смотрите также»", () => {
  const client = "Показываем набор «Леонардо».\n\nСмотрите также: наш каталог на сайте\nТелефон в шапке канала.";
  const rel1 = ["Серия «Покрытие своими руками»: https://www.youtube.com/playlist?list=PL1"];
  const first = swapRelations(client, rel1, null);
  assert.equal(first.description, `${client}\n\n${rel1[0]}`, "блок дописан в конец, строка клиента на месте");
  assert.equal(first.state.first, client, "описание до первой правки запомнено");
  // Второй запуск убирает ровно прошлый блок и ставит новый.
  const rel2 = [...rel1, "Смотрите также: https://youtu.be/abcdefghijk | Прораб Олег"];
  const second = swapRelations(first.description, rel2, first.state);
  assert.equal(second.description, `${client}\n\n${rel2.join("\n")}`);
  assert.equal(second.state.first, client);
  // Клиент поправил свой текст и оставил наш блок: текст его, блок обновлён.
  const edited = first.description.replace("Показываем", "Собираем");
  assert.match(swapRelations(edited, rel2, first.state).description, /^Собираем набор/);
  // Блок убрали руками: не трогаем и говорим об этом.
  const gone = swapRelations(client, rel2, first.state);
  assert.equal(gone.description, client);
  assert.match(gone.skipped, /правили руками/);
  // Пустой блок возвращает описание клиента.
  assert.equal(swapRelations(first.description, [], first.state).description, client);
});

/* ── Telegram: сверка оборванной отправки по витрине ─────────────────────── */

test("витрина канала: пост находится по началу текста, разметка и регистр не мешают", () => {
  const html = [
    '<div class="tgme_widget_message_wrap"><div data-post="ecopolis_kzn/700"><div class="tgme_widget_message_text">Старый пост о швах.</div></div></div>',
    '<div class="tgme_widget_message_wrap"><div data-post="ecopolis_kzn/701"><div class="tgme_widget_message_text">Записи &laquo;покрытие выполнено некачественно&raquo; в акте приёмки <b>недостаточно</b>: в ней нет ни места.</div></div></div>',
  ].join("");
  const text = "Записи «покрытие выполнено некачественно» в акте приёмки недостаточно: в ней нет ни места, ни размера, ни признака.";
  assert.deepEqual(findInShowcase(html, text), { id: "701", link: "https://t.me/ecopolis_kzn/701" });
  assert.equal(findInShowcase(html, "Совсем другой пост, которого на витрине нет и не было."), null);
  // Страница без постов — это не витрина: судить по ней нельзя.
  assert.equal(findInShowcase("<html>ошибка</html>", text), undefined);
});

/* ── Снимок: то, что человек мог набрать сам, в счёт не попадает ─────────── */

test("снимок: телефон, набранный после /start, не уезжает под видом метки входа", () => {
  const known = ["priemka", "rashod"];
  assert.equal(entryLabel("вход-ig-priemka-17841400000000000", known), "ig-priemka");
  assert.equal(entryLabel("вход-yt-rashod", known), "yt-rashod");
  assert.equal(entryLabel("вход-priemka", known), "priemka");
  assert.equal(entryLabel("вход-direct", known), "direct");
  assert.equal(entryLabel("вход-89171234567", known), "прочее");
  assert.equal(entryLabel("вход-ivanov@mail.ru", known), "прочее");
  assert.equal(entryLabel("вход-yt-ivanov", known), "yt-прочее");
  assert.equal(safeKey("vk"), "vk");
  assert.equal(safeKey("Покрытие для площадки"), "Покрытие для площадки");
  assert.equal(safeKey("89171234567"), "прочее");
  assert.equal(safeKey("ivanov@mail.ru"), "прочее");
  const f = funnel({ subscribers: [{ id: "1", updatedAt: new Date().toISOString(), tags: ["вход-89171234567"] }, { id: "2", updatedAt: new Date().toISOString(), tags: ["вход-yt-priemka"] }], knownEntries: known, clicks: [{ at: new Date().toISOString(), device: "mobile", c: "yt", slug: "priemka", p: "+79171234567" }] });
  assert.deepEqual(f.bot.byEntry, { "прочее": 1, "yt-priemka": 1 });
  assert.equal(JSON.stringify(f).includes("9171234567"), false);
});

test("снимок: номера Telegram людей клиента убраны и у согласия, и у просьбы о правке", () => {
  const out = publicEntry({ id: "x", by: "tg:42", approval: { by: 42, name: "Анна", at: "2030-03-12T10:00:00Z" }, fixAsked: { by: 42, name: "Анна" } });
  assert.equal(out.by, "рабочая группа");
  assert.deepEqual(out.approval, { name: "Анна", at: "2030-03-12T10:00:00Z" });
  assert.deepEqual(out.fixAsked, { name: "Анна" });
});

/* ── Перехват и копия расписания ─────────────────────────────────────────── */

test("перехват: записи, чей слот наступил до перехвата, компьютер сам не выпускает", () => {
  const now = Date.parse("2030-03-12T16:00:00+03:00");
  const e = (name, channel, time, status = "approved") => ({ id: name, name, channel, kind: "post", date: "2030-03-12", time, status });
  const risky = atRisk([e("utro", "telegram", "10:00"), e("vecher", "threads", "19:00"), e("rolik", "youtube", "15:00"), e("zhdet", "vk", "12:00", "review"), e("idet", "vk", "18:00", "running")], now);
  // Утренний пост сервер мог выпустить перед остановкой. Вечерняя ветка ещё впереди.
  // Ролик YouTube открывает сам YouTube: выпуск его только сверяет. Неодобренное не выходит вовсе.
  // Запись, которая в копии «выходит», сервер начал и мог закончить: её тоже смотрит человек.
  assert.deepEqual(risky.map((x) => x.name), ["utro", "idet"]);
});

test("копия расписания: вышедшее за шестьдесят дней стоит отдельным разделом", () => {
  const now = Date.parse("2030-03-12T09:00:00+03:00");
  const e = (name, date, status, over = {}) => ({ id: name, name, channel: "threads", kind: "thread", date, time: "19:00", status, material: "blog:x", posts: [`Начало ветки ${name}`], ...over });
  const text = renderSchedule([e("staraya", "2030-02-20", "published"), e("davnyaya", "2029-12-01", "published"), e("segodnya", "2030-03-12", "approved"), e("paket", "2030-03-10", "handed", { channel: "dzen", kind: "article", title: "Статья для Дзена", posts: undefined })], now, { threads: "Threads", dzen: "Дзен" });
  assert.match(text, /## Вышло за 60 дней/);
  assert.match(text, /Начало ветки staraya/);
  assert.doesNotMatch(text, /davnyaya/, "старше шестидесяти дней в окно не входит");
  assert.match(text, /## Переданы на ручную выкладку/);
  assert.match(text, /Статья для Дзена/);
});

/* ── Заслон приёма: четыре записи ────────────────────────────────────────── */

test("приём открывают четыре записи: три документа и подтверждение по Роскомнадзору", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "zavod-legal-"));
  const dir = path.join(root, "legal", "site");
  mkdirSync(dir, { recursive: true });
  for (const doc of LEGAL_DOCS) writeFileSync(path.join(dir, `${doc}.md`), `# ${doc}\nТекст без пустых мест.`);
  const stamp = { by: "Юрист клиента", date: "2026-10-20" };
  const three = Object.fromEntries(LEGAL_DOCS.map((d) => [d, { version: "2026-10-1", ...stamp }]));
  writeFileSync(path.join(dir, "approved.json"), JSON.stringify(three));
  // Тексты утверждены, а про Роскомнадзор ответа нет: приём закрыт.
  assert.deepEqual(legalGaps(root), Object.values(LEGAL_CONFIRMATIONS));
  writeFileSync(path.join(dir, "approved.json"), JSON.stringify({ ...three, "uvedomlenie-rkn": { ...stamp, note: "уведомления поданы 19.10.2026" } }));
  assert.deepEqual(legalGaps(root), []);
});

/* ── Команды очереди ─────────────────────────────────────────────────────── */

const { execute } = await import("../src/queue/commands.mjs");
const store = await import("../src/queue/store.mjs");
const ledger = await import("../src/queue/ledger.mjs");

const video = (channel, kind, name, over = {}) => ({
  channel, kind, name, material: "blog:primer",
  ...(channel === "instagram" ? { text: "Толщину покрытия на глаз не проверить" } : { title: "На площадке режем покрытие до основания", text: "Толщину по внешнему виду не оценить." }),
  media: [{ type: "video", url: "https://s3.example.ru/rolik.mp4" }], hashtags: ["покрытие"], ...over,
});

test("постановка ролика: Instagram встаёт после премьеры на YouTube, раньше поставить нельзя молча", async () => {
  const yt = await execute("add", { entries: [video("youtube", "short", "premiera")] }, "S2");
  assert.equal(yt.code, 0);
  const premiere = store.all().find((e) => e.channel === "youtube" && e.name === "premiera");
  assert.equal(premiere.time, "15:00", "YouTube встаёт по рабочей сетке");
  await execute("add", { entries: [video("instagram", "reel", "premiera")] }, "S2");
  const reel = store.all().find((e) => e.channel === "instagram" && e.name === "premiera");
  assert.equal(reel.date, premiere.date, "рилс выходит в день премьеры");
  assert.ok(dueAt(reel) > dueAt(premiere), "и после неё");
  // Время руками раньше премьеры: команда не молчит.
  const early = await execute("add", { entries: [video("rutube", "short", "premiera", { date: premiere.date, time: "10:10" })] }, "S2");
  assert.match(early.lines.join("\n"), /YouTube идёт первым/);
  // Время вне слотов площадки: тоже сказано.
  const odd = await execute("add", { entries: [{ channel: "telegram", kind: "post", name: "srochno", material: "blog:primer", date: premiere.date, time: "13:37", text: "Площадку в Казани приняли после дождя." }] }, "S1");
  assert.match(odd.lines.join("\n"), /времени 13:37 нет среди слотов/);
});

test("submit по имени ролика отправляет все его черновики; одна запись требует площадку только там, где нужна одна", async () => {
  sent.length = 0;
  const out = await execute("submit", { ref: "premiera" }, "S2");
  assert.equal(out.code, 0);
  assert.equal(out.lines.filter((l) => l.startsWith("на согласовании")).length, 3, "YouTube, Instagram и Rutube ушли тремя карточками");
  // show по тому же имени без площадки называет площадки, а не падает молча.
  const shown = await execute("show", { ref: "premiera" });
  assert.equal(shown.code, 1);
  assert.match(shown.lines.join("\n"), /на нескольких площадках \(.*youtube.*\): добавьте --channel/);
  assert.equal((await execute("show", { ref: "premiera", channel: "youtube" })).code, 0);
});

test("вывод команд не несёт номеров Telegram людей клиента", async () => {
  const yt = store.all().find((e) => e.channel === "youtube" && e.name === "premiera");
  await store.transition(yt.id, "approved", { approval: { by: 42, name: "Анна", at: new Date().toISOString() } }, "tg:42");
  const shown = await execute("show", { ref: yt.id, history: true });
  const text = shown.lines.join("\n");
  assert.doesNotMatch(text, /tg:42/);
  assert.match(text, /рабочая группа → одобрено, ждёт слота/);
  assert.equal(shown.data.by, "рабочая группа");
  assert.equal(shown.data.approval.by, undefined);
  assert.equal(shown.data.approval.name, "Анна");
  const listed = await execute("list", { all: true });
  assert.equal(JSON.stringify(listed.data).includes("tg:42"), false);
});

test("остановку ради перехвата снимает только возврат расписания", async () => {
  assert.equal((await execute("pause", { reason: "перехват", takeover: true }, "оператор (дубль)")).code, 0);
  assert.equal(stopState().takeover, true);
  const refused = await execute("resume", {}, "оператор");
  assert.equal(refused.code, 1, "отказ по правилу, а не поломка");
  assert.match(refused.lines.join("\n"), /handback/);
  assert.equal(stopState().stopped, true);
  assert.equal((await execute("resume", { handback: true }, "оператор (дубль)")).code, 0);
  assert.equal(stopState().stopped, false);
});

test("перехват не начинается, если выпуск остановил человек; возврат его слово не снимает", async () => {
  clearStop({ all: true });
  assert.equal((await execute("pause", { reason: "ждём юриста" }, "оператор")).code, 0);
  const refused = await execute("pause", { reason: "перехват", takeover: true }, "оператор (дубль)");
  assert.equal(refused.code, 1, "отказ по правилу");
  assert.match(refused.lines.join("\n"), /остановлен человеком.*Перехватывать нечего/);
  assert.equal(stopState().takeover, false);
  // Перехват уже идёт, сервер вернулся после простоя: отметка ставится и поверх слова человека.
  assert.equal((await execute("pause", { reason: "перехват", takeover: true, ongoing: true }, "оператор (дубль)")).code, 0);
  assert.deepEqual([stopState().human, stopState().takeover], [true, true]);
  // Команда оператора «включить» снимает слово человека, но не перехват.
  const resumed = await execute("resume", {}, "оператор");
  assert.equal(resumed.code, 0);
  assert.match(resumed.lines.join("\n"), /расписание всё ещё ведёт компьютер оператора/);
  assert.deepEqual([stopState().human, stopState().takeover], [false, true]);
  // Возврат при стоящем слове человека: перехват снят, выпуск остаётся остановленным.
  await execute("pause", { reason: "ждём юриста" }, "оператор");
  writeFileSync(path.join(DATA, "HOLD"), "{}");
  const back = await execute("resume", { handback: true }, "оператор (дубль)");
  assert.equal(back.code, 0);
  assert.match(back.lines.join("\n"), /остаётся остановленным: его остановил человек/);
  assert.deepEqual([stopState().stopped, stopState().human, stopState().takeover], [true, true, false]);
  assert.equal(existsSync(path.join(DATA, "HOLD")), false, "удержание после простоя возврат снимает: вышедшее он уже передал");
  clearStop({ all: true });
});

test("сверка при перехвате: сервер отдаёт рубильник, статусы и то, что успел сделать с записью", async () => {
  const { entry } = await store.put({ channel: "threads", kind: "thread", name: "nachata-serverom", material: "blog:primer", date: "2030-05-06", time: "19:00", posts: ["Подрядчик в Казани сдал площадку весной.", "Через год покрытие пошло трещинами.", "Причина нашлась в акте приёмки."] }, "S1");
  await store.transition(entry.id, "review", {}, "S1");
  await store.transition(entry.id, "approved", { approval: { by: 42, name: "Анна", at: new Date().toISOString() } }, "tg:42");
  // Сервер выпустил первую реплику, вторая не ушла: запись вернулась на повтор.
  await store.transition(entry.id, "running", { startedAt: new Date().toISOString(), attempts: 1 }, "выпуск");
  await store.transition(entry.id, "approved", { done: ["p1"], result: { link: "https://www.threads.net/@eco/post/p1" } }, "выпуск");
  const pulse = await execute("pulse", {}, "оператор (дубль)");
  assert.equal(pulse.code, 0);
  assert.deepEqual(Object.keys(pulse.data).sort(), ["busy", "fresh", "hashes", "held", "progress", "restored", "statuses", "stop"]);
  assert.equal(pulse.data.hashes[entry.id], store.get(entry.id).contentHash, "отпечаток одобренного текста: по нему компьютер видит правку после копии");
  assert.equal(pulse.data.statuses[entry.id], "approved");
  assert.deepEqual(pulse.data.progress[entry.id], { done: ["p1"], attempts: 1, result: { link: "https://www.threads.net/@eco/post/p1" } });
  assert.equal(pulse.data.busy, false);
  // Идёт проход выпуска: стоит свежий замок.
  writeFileSync(path.join(DATA, "runner.lock"), "1");
  assert.equal((await execute("pulse", {})).data.busy, true);
  rmSync(path.join(DATA, "runner.lock"));
  await execute("cancel", { ref: entry.id });
});

test("возврат расписания повторяем: вторая отметка той же записи строку в журнал не дописывает", async () => {
  const mk = async (name, over = {}) => {
    const { entry } = await store.put({ channel: "threads", kind: "thread", name, material: "blog:primer", date: "2030-05-09", time: "19:00", posts: ["На площадке в Казани толщину проверили до подписи акта.", `Что смотрели в случае «${name}», записано в журнале.`], ...over }, "S1");
    await store.transition(entry.id, "review", {}, "S1");
    await store.transition(entry.id, "approved", { approval: { by: 42, name: "Анна", at: new Date().toISOString() } }, "tg:42");
    return entry;
  };
  const out = await mk("vyshla-pri-perehvate");
  const args = { ref: out.id, link: "https://www.threads.net/@eco/post/88", externalId: "88", takeover: true };
  assert.equal((await execute("mark", args, "оператор (дубль)")).code, 0);
  const again = await execute("mark", args, "оператор (дубль)");
  assert.equal(again.code, 0);
  assert.match(again.lines.join("\n"), /уже отмечена вышедшей/);
  assert.equal(ledger.rows().filter((r) => r.id === out.id && r.status === "published").length, 1, "по журналу считается суточный потолок площадки");

  // Пакет на ручную выкладку: то же, и он не становится «вышедшим».
  const pack = await mk("paket-pri-perehvate", { channel: "dzen", kind: "article", title: "Где покрытие отслаивается чаще всего", text: "Примыкания относятся к самым уязвимым местам резинового покрытия. ".repeat(14), posts: undefined });
  const handed = { ref: pack.id, handed: true, packageMessageId: 9001, takeover: true };
  assert.equal((await execute("mark", handed, "оператор (дубль)")).code, 0);
  assert.equal((await execute("mark", handed, "оператор (дубль)")).code, 0);
  assert.equal(store.get(pack.id).status, "handed");
  assert.equal(store.get(pack.id).result.packageMessageId, 9001);
  assert.equal(ledger.rows().filter((r) => r.id === pack.id && r.status === "handed").length, 1);

  // Начатая и не законченная ветка: сервер продолжит с места обрыва и со сверкой.
  const part = await mk("nachata-kompyuterom");
  const partial = await execute("mark", { ref: part.id, partial: true, done: ["p1"], result: { link: "https://www.threads.net/@eco/post/p1" }, takeover: true }, "оператор (дубль)");
  assert.equal(partial.code, 0);
  const saved = store.get(part.id);
  assert.deepEqual([saved.status, saved.done, saved.attempts, saved.result.link], ["approved", ["p1"], 1, "https://www.threads.net/@eco/post/p1"]);

  // Пакет ушёл с компьютера, а на сервере запись сняли: закрыта, в журнале одна строка, группа знает.
  const stray = await mk("paket-bez-soglasiya", { channel: "dzen", kind: "article", title: "Как принять покрытие у подрядчика", text: "Приёмку покрытия ведут по акту, а не на глаз. ".repeat(20), posts: undefined });
  await store.transition(stray.id, "cancelled", { note: "снял(а) Анна" }, "tg:42");
  sent.length = 0;
  for (let i = 0; i < 2; i++) {
    const res = await execute("mark", { ref: stray.id, handed: true, takeover: true }, "оператор (дубль)");
    assert.equal(res.code, 0, "возврат на такой записи не застревает");
    assert.match(res.lines.join("\n"), /пакет ушёл без согласия/);
  }
  assert.equal(ledger.rows().filter((r) => r.id === stray.id && r.status === "handed" && r.withoutApproval).length, 1);
  assert.match(sent.map((s) => s.body.text || "").join("\n"), /не выкладывайте этот пакет/);
});

test("возврат расписания: запись, вышедшая без согласия, закрывается, а группа узнаёт об этом сразу", async () => {
  const { entry } = await store.put({ channel: "threads", kind: "thread", name: "snyali-pered-avariej", material: "blog:primer", date: "2030-05-07", time: "19:00", posts: ["На площадке в Казани толщину проверили до подписи акта.", "Что именно смотрели, записано в журнале."] }, "S1");
  // На сервере запись ждёт «да» (утверждающий отозвал согласие), а компьютер по старой копии её выпустил.
  await store.transition(entry.id, "review", {}, "S1");
  sent.length = 0;
  const out = await execute("mark", { ref: entry.id, link: "https://www.threads.net/@eco/post/77", takeover: true }, "оператор (дубль)");
  assert.equal(out.code, 0, "возврат не застревает на такой записи");
  assert.match(out.lines.join("\n"), /вышла без согласия/);
  assert.equal(store.get(entry.id).status, "cancelled", "после согласования она не выйдет второй раз");
  assert.ok(ledger.rows().some((r) => r.id === entry.id && r.status === "published" && r.withoutApproval), "факт публикации записан в журнал");
  const alarm = sent.map((s) => s.body.text || "").join("\n");
  assert.match(alarm, /вышла во время аварии сервера/);
  assert.match(alarm, /Что сделать/);
  // Без признака возврата та же команда отказывает по правилу: руками так не отмечают.
  const { entry: other } = await store.put({ channel: "threads", kind: "thread", name: "prosto-chernovik", material: "blog:primer", date: "2030-05-08", time: "19:00", posts: ["Подрядчик сдал площадку в срок.", "Акт подписали с замечаниями."] }, "S1");
  assert.equal((await execute("mark", { ref: other.id, link: "https://x" }, "оператор")).code, 1);
});

/* ── Ролик YouTube: текст на ролике и текст в записи ─────────────────────── */

const fakeYoutube = async () => {
  const schedule = await import("../src/video/schedule.mjs");
  const yt = { publishAt: "", calls: [] };
  schedule._setApi({
    status: async (id) => ({ kind: "ok", privacy: "private", publishAt: yt.publishAt, raw: { id, status: { privacyStatus: "private" } } }),
    setSchedule: async (v, publishAt) => { yt.calls.push(publishAt); yt.publishAt = publishAt; return { ok: true }; },
  });
  return { yt, schedule };
};
const approve = async (id) => {
  await store.transition(id, "review", {}, "S2");
  return store.transition(id, "approved", { approval: { by: 42, name: "Анна", at: new Date().toISOString() } }, "tg:42");
};

test("запись правили после загрузки ролика: пока на YouTube прежние название и описание, срок не ставится и ролик не открывается", async () => {
  const { yt, schedule } = await fakeYoutube();
  const slot = { date: "2030-06-04", time: "15:00" };
  const iso = new Date(dueAt(slot)).toISOString();
  const raw = video("youtube", "short", "pravili-posle-zagruzki", slot);
  const { entry } = await store.put(raw, "S2");
  await approve(entry.id);
  // Загрузка: номер ролика и отпечаток отправленного текста. Срок встаёт тут же.
  const up = await execute("extra", { ref: entry.id, fields: { youtubeId: "ccccccccccc", youtubeHash: store.get(entry.id).contentHash } }, "S2");
  assert.equal(yt.publishAt, iso);
  assert.match(up.lines.join("\n"), /Срок выхода ролика на YouTube/);

  // Утверждающий попросил другое название: запись уходит в черновики, срок снят.
  await execute("add", { entries: [{ ...raw, title: "Покрытие вырезали до основания при заказчике" }] }, "S2");
  assert.equal(store.get(entry.id).status, "draft");
  assert.equal(yt.publishAt, "");

  // Новое «да». На ролике лежит название, которому сказали «нет»: срок не ставится.
  await approve(entry.id);
  const said = await schedule.afterChange(entry.id);
  assert.equal(yt.publishAt, "", "ролик с отклонённым названием срока не получает");
  assert.match(said, /прежние название и описание/);
  assert.match(said, /npm run yt -- --update --id=pravili-posle-zagruzki/);
  assert.deepEqual((await schedule.syncAll()).stale, ["pravili-posle-zagruzki"]);
  // И в минуту слота выпуск его не открывает.
  const youtube = await import("../src/channels/youtube.mjs");
  const refused = await youtube.publish(store.get(entry.id));
  assert.deepEqual([refused.ok, refused.retry], [false, false]);
  assert.match(refused.error, /прежние название и описание/);

  // Команда --update отправила новый текст и записала его отпечаток: срок встал.
  await execute("extra", { ref: entry.id, fields: { youtubeHash: store.get(entry.id).contentHash } }, "S2");
  assert.equal(yt.publishAt, iso);
  schedule._setApi(null);
});

test("запись сняли, пока ролик загружался: срок, с которым он ушёл на YouTube, снимается сразу", async () => {
  const { yt, schedule } = await fakeYoutube();
  const slot = { date: "2030-06-06", time: "15:00" };
  const iso = new Date(dueAt(slot)).toISOString();
  const { entry } = await store.put(video("youtube", "short", "snyali-vo-vremya-zagruzki", slot), "S2");
  await approve(entry.id);
  const hash = store.get(entry.id).contentHash;
  // Загрузка началась при одобренной записи и идёт минуты. За это время запись сняли.
  await execute("cancel", { ref: entry.id, reason: "снял(а) Анна" }, "tg:42");
  yt.publishAt = iso; // ролик уже лежит на YouTube со сроком из слота
  const done = await execute("extra", { ref: entry.id, fields: { youtubeId: "ddddddddddd", youtubePublishAt: iso, youtubeHash: hash } }, "S2");
  assert.equal(yt.publishAt, "", "срок снят в ту же минуту, а не через пять");
  assert.match(done.lines.join("\n"), /Срок выхода на YouTube снят: ролик остаётся закрытым/);
  schedule._setApi(null);
});

/* ── Telegram: публикация без слепого повтора ────────────────────────────── */

test("пост в канал после обрыва связи не отправляется второй раз тем же вызовом", async () => {
  const telegram = await import("../src/channels/telegram.mjs");
  process.env.TG_CHANNEL = "@ecopolis_kzn";
  const real = globalThis.fetch;
  let tries = 0;
  // Запрос ушёл, ответ потерялся: пост мог выйти.
  globalThis.fetch = async () => { tries++; throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); };
  const state = [];
  try {
    const out = await telegram.publish({ text: "Площадку в Казани приняли после дождя." }, { onState: async (f) => { state.push(f); } });
    assert.equal(tries, 1, "повтор внутри вызова дал бы второй пост в канале");
    assert.deepEqual([out.ok, out.retry], [false, true]);
    assert.deepEqual(state, [{ tgSending: true }], "отметка «отправка начата» осталась: следующий проход сначала сверится с каналом");
  } finally {
    globalThis.fetch = real;
    delete process.env.TG_CHANNEL;
  }
});

/* ── Готовность: слово выключенного сценария и голая ссылка на бота ──────── */

test("готовность: слово выключенного сценария останавливает и при открытом приёме; голая ссылка на бота считается ссылкой в бота", async () => {
  const open = { legal: true, codeWords: ["ПРИЁМКА", "ТОЛЩИНА"], deadWords: ["ТОЛЩИНА"], botUsername: "eco_bot" };
  const reel = (text) => ({ channel: "instagram", kind: "reel", name: "r", text });
  assert.match(ready(reel("Памятку пришлём в личные сообщения. Напишите слово ТОЛЩИНА."), open).block.join("|"), /выключенному сценарию/);
  assert.deepEqual(ready(reel("Чек-лист пришлём в личные сообщения. Напишите слово ПРИЁМКА."), open).block, []);
  assert.deepEqual(ready(reel("Толщина слоя на площадке 10 мм."), open).block, [], "обычное слово строчными словом бота не считается");
  const closed = { ...open, legal: false };
  assert.match(ready(post("Вопросы принимает бот: https://t.me/eco_bot"), closed).block.join("|"), /ссылка в бота/);
  assert.match(ready(post("Напишите нашему боту @eco_bot, он пришлёт чек-лист."), closed).block.join("|"), /ссылка в бота/);
  assert.deepEqual(ready(post("Канал компании: https://t.me/eco_bot_news"), closed).block, [], "чужое имя с тем же началом ссылкой в бота не считается");
  // В проекте сценарий «толщина» выключен: его слово названо мёртвым, живые слова нет.
  const gates = await import("../src/gates/index.mjs");
  assert.deepEqual(gates.deadWords(), ["ТОЛЩИНА"]);
  assert.ok(gates.codeWords().includes("ТОЛЩИНА") && gates.codeWords().includes("ПРИЁМКА"));
});

/* ── Запись в каталог данных только под пользователем завода ─────────────── */

test("запись в каталог данных под чужим пользователем запрещена в одном месте: журнал, замена файла и замок", async () => {
  const files = await import("../src/lib/files.mjs");
  files._setForeign("команда запущена под root, а каталог данных принадлежит пользователю завода");
  try {
    const writes = [
      () => files.appendJsonl(path.join(DATA, "x.jsonl"), { a: 1 }),
      () => files.writeAtomic(path.join(DATA, "x.json"), "{}"),
      () => files.lock(path.join(DATA, "x.lock")),
    ];
    for (const write of writes) assert.throws(write, (e) => e.code === "ENV" && /под root/.test(e.message));
    assert.equal(existsSync(path.join(DATA, "x.jsonl")), false);
    // Читать можно, писать вне каталога данных тоже.
    assert.ok(files.readJsonl(path.join(DATA, "queue.jsonl")).length > 0);
    files.writeAtomic(path.join(mkdtempSync(path.join(os.tmpdir(), "zavod-out-")), "y.json"), "{}");
    // Команда очереди отвечает поломкой окружения с объяснением, а не падает и не пишет.
    const out = await execute("pause", { reason: "проба" }, "оператор");
    assert.equal(out.code, 2);
    assert.match(out.lines.join("\n"), /под root/);
    assert.equal(stopState().stopped, false);
  } finally {
    files._setForeign(null);
  }
});

/* ── Рубильник: файл есть, значит, выпуск стоит ──────────────────────────── */

test("файл STOP, в котором не разобрать отметок, всё равно останавливает выпуск", () => {
  const file = path.join(DATA, "STOP");
  clearStop({ all: true });
  // Пустой, «{}», «[]», слово, положенное руками: всё это «стоп» человека.
  for (const text of ["", "{}", "[]", "null", "стоп", "{\"comment\":123}"]) {
    writeFileSync(file, text);
    assert.deepEqual([stopState().stopped, stopState().human, stopState().takeover], [true, true, false], `содержимое: ${JSON.stringify(text)}`);
  }
  // Файл прежнего вида: одна отметка с причиной и признаком перехвата.
  writeFileSync(file, JSON.stringify({ at: "2026-10-10T10:00:00Z", by: "Анна", reason: "команда /stop_release", takeover: false }));
  assert.deepEqual([stopState().human, stopState().takeover, stopState().by], [true, false, "Анна"]);
  writeFileSync(file, JSON.stringify({ at: "2026-10-10T10:00:00Z", by: "оператор (дубль)", reason: "перехват", takeover: true }));
  assert.deepEqual([stopState().human, stopState().takeover], [false, true]);
  // Третья отметка, возврата, живёт рядом с двумя другими и снимается отдельно.
  clearStop({ all: true });
  setStop({ by: "Анна", reason: "команда /stop_release" });
  setStop({ by: "возврат расписания", reason: "расписание возвращается серверу", handback: true });
  assert.deepEqual([stopState().human, stopState().handback, stopState().by], [true, true, "Анна"]);
  assert.deepEqual([clearStop({ handback: true }).human, stopState().handback], [true, false]);
  clearStop({ all: true });
});
