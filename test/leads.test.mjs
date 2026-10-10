// Заявки и бот: счётчик ссылок, форма, путь человека в боте, отзыв согласия, снимок без персональных данных.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = mkdtempSync(path.join(os.tmpdir(), "zavod-leads-"));
process.env.DATA_DIR = DATA;
process.env.ZAVOD_ENV_FILE = path.join(DATA, "нет-такого.env");
process.env.TG_BOT_TOKEN = "test-token";
process.env.TG_BOT_USERNAME = "eco_test_bot";
process.env.TG_GROUP_ID = "-1001";
process.env.STAFF_IDS = "77";
process.env.APPROVER_IDS = "42";
process.env.PUBLIC_BASE_URL = "https://go.example.ru";
delete process.env.TG_RELAY_URL;
delete process.env.IG_RELAY_URL;

// Подмена Telegram: запоминаем вызовы, отвечаем успехом.
const sent = [];
let messageId = 500;
globalThis.fetch = async (url, init) => {
  const method = String(url).split("/").pop();
  const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : {};
  sent.push({ method, body });
  return new Response(JSON.stringify({ ok: true, result: { message_id: ++messageId, chat: { id: body.chat_id } } }), { status: 200 });
};
const lines = (file) => (existsSync(path.join(DATA, "leads", file)) ? readFileSync(path.join(DATA, "leads", file), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const lastText = (chat) => [...sent].reverse().find((s) => String(s.body.chat_id) === String(chat) && s.body.text)?.body.text || "";

const { clickStats, handleGo, target } = await import("../src/leads/go.mjs");
const { renderForm, submitForm } = await import("../src/leads/form.mjs");
const customer = await import("../src/bot/customer.mjs");
const leadsBot = await import("../src/bot/leads.mjs");
const { erase, select } = await import("../src/leads/erase.mjs");
const { funnel, mask, questions } = await import("../src/queue/snapshot.mjs");
const { plan, toEvent } = await import("../src/bot/ig-poll.mjs");
const { buildReply } = await import("../src/bot/ig-flow.mjs");
const { recipients } = await import("../src/channels/bot.mjs");
const { bot } = await import("../src/bot/instance.mjs");

test("короткая ссылка ведёт на статью с метками площадки и записи", () => {
  const links = { priemka: { url: "https://ecopolisrf.ru/blog/priemka/" } };
  const t = target("priemka", { c: "yt", p: "val-2" }, links, "https://ecopolisrf.ru");
  assert.equal(t.known, true);
  assert.equal(t.url, "https://ecopolisrf.ru/blog/priemka/?utm_source=yt&utm_medium=social&utm_campaign=priemka&utm_content=val-2");
  assert.equal(new URL(target("priemka", { c: "bot-vk" }, links, "https://ecopolisrf.ru").url).searchParams.get("utm_medium"), "bot");
  const unknown = target("opechatka", { c: "<script>" }, links, "https://ecopolisrf.ru");
  assert.equal(unknown.known, false);
  assert.match(unknown.url, /^https:\/\/ecopolisrf\.ru\/\?utm_source=script/);
});

test("переход записывается без адреса посетителя, робот превью считается отдельно", () => {
  const req = (ua) => ({ headers: { "user-agent": ua, "x-real-ip": "203.0.113.7" } });
  const out = handleGo(new URL("https://go.example.ru/go/priemka?c=yt&p=val-2"), req("Mozilla/5.0 (iPhone)"));
  assert.equal(out.status, 302);
  assert.match(out.headers.location, /utm_source=yt/);
  handleGo(new URL("https://go.example.ru/go/priemka?c=yt"), req("TelegramBot (like TwitterBot)"));
  const raw = readFileSync(path.join(DATA, "go-clicks.jsonl"), "utf8");
  assert.doesNotMatch(raw, /203\.0\.113\.7/, "IP в журнал не попадает");
  const s = clickStats();
  assert.equal(s.total, 1);
  assert.deepEqual(s.byChannel, { yt: 1 });
});

test("форма: две неотмеченные галочки и ссылка на полный текст согласия", () => {
  const html = renderForm("raschet", { c: "vk", p: "post-1" });
  assert.match(html, /name="consent_pd" value="1" required>/);
  assert.match(html, /name="consent_ads" value="1">/);
  assert.doesNotMatch(html, /checked/);
  assert.match(html, /ИНН 1655274420/);
  assert.match(html, /href="\/doc\/soglasie"/);
  assert.match(html, /name="c" value="vk"/);
});

test("форма без согласия заявку не создаёт; с согласием заявка записана раньше карточки", async () => {
  const who = { ip: "203.0.113.9", ua: "test" };
  const noConsent = await submitForm("raschet", new URLSearchParams({ name: "Анна", phone: "+7 (999) 111-22-33", need: "pokrytie" }), who);
  assert.equal(noConsent.status, 400);
  assert.equal(lines("leads.jsonl").length, 0);

  sent.length = 0;
  const ok = await submitForm("raschet", new URLSearchParams({ name: "Анна", phone: "+7 (999) 111-22-33", need: "pokrytie", comment: "Школа, 450 м²", consent_pd: "1", consent_ads: "1", c: "vk", p: "post-1" }), who);
  assert.equal(ok.status, 200);
  const [lead] = lines("leads.jsonl");
  assert.equal(lead.source, "ecopolis:vk");
  assert.equal(lead.phone, "+79991112233");
  assert.equal(lead.consent.version, "2026-10-1");
  assert.deepEqual(lines("consents.jsonl").map((c) => `${c.kind}:${c.action}`), ["pd:given", "ads:given"]);
  const card = sent.find((s) => s.method === "sendMessage" && String(s.body.chat_id) === "-1001");
  assert.match(card.body.text, /Заявка · Покрытие для площадки/);
  assert.match(card.body.text, /Школа, 450 м²/);
  assert.equal(card.body.reply_markup.inline_keyboard.at(-1).length, 2, "кнопки «Взял в работу» и «Не целевая»");
});

test("поле-ловушка: роботу отвечаем как обычно, заявку не создаём", async () => {
  const before = lines("leads.jsonl").length;
  const out = await submitForm("raschet", new URLSearchParams({ name: "Бот", phone: "89990000000", consent_pd: "1", website: "http://spam" }), { ip: "1.1.1.1", ua: "x" });
  assert.equal(out.status, 200);
  assert.equal(lines("leads.jsonl").length, before);
});

const from = { id: 9001, first_name: "Пётр", last_name: "Смирнов", username: "petr_s" };
const say = (text, extra = {}) => customer.handleMessage({ chat: { id: 9001, type: "private" }, from, text, ...extra });
const tap = (data) => customer.handleCallback({ id: "cb", data, from, message: { chat: { id: 9001 } } });

test("человек из ВКонтакте получает материал сразу, имя до согласия не записывается", async () => {
  sent.length = 0;
  await say("/start vk-priemka");
  const m = sent.find((s) => String(s.body.chat_id) === "9001");
  assert.match(m.body.text, /Чек-лист приёмки резинового покрытия/);
  assert.equal(m.body.reply_markup.inline_keyboard[0][0].url, "https://go.example.ru/go/priemka?c=bot-vk");
  assert.equal(m.body.reply_markup.inline_keyboard[1][0].callback_data, "c:lead");
  const sub = await bot().telegram.store.findSubscriber("9001");
  assert.equal(sub.entryOrigin, "vk");
  assert.equal(sub.firstName, undefined, "имя появляется только после согласия");
  assert.equal(sub.username, undefined);
});

test("заявка в боте: вопрос, согласие отдельным сообщением, запись, карточка в группу", async () => {
  await tap("c:lead");
  assert.match(lastText(9001), /Что вам нужно/);
  await tap("c:need:pokrytie");
  const consent = lastText(9001);
  assert.match(consent, /ИНН 1655274420/);
  assert.match(consent, /https:\/\/go\.example\.ru\/doc\/soglasie/);
  assert.match(consent, /\/stop/);
  const before = lines("leads.jsonl").length;
  sent.length = 0;
  await tap("c:pd:yes");
  const mine = lines("leads.jsonl").slice(before);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].source, "ecopolis:vk");
  assert.equal(mine[0].material, "priemka");
  assert.equal(mine[0].name, "Пётр Смирнов");
  assert.match(sent.find((s) => String(s.body.chat_id) === "-1001").body.text, /Откуда: ВКонтакте · метка vk-priemka/);
  assert.match(lastText(9001), /оставьте номер/);
  // Повторное нажатие вторую заявку не создаёт.
  await tap("c:pd:yes");
  assert.equal(lines("leads.jsonl").length, before + 1);
});

test("«Без телефона» — это отказ от телефона, а не вопрос специалисту", async () => {
  sent.length = 0;
  await say("Без телефона");
  assert.ok(!sent.some((s) => String(s.body.chat_id) === "-1001" && /Вопрос из бота/.test(s.body.text || "")));
  assert.match(lastText(9001), /Присылать вам новые материалы/);
  await tap("c:ads:yes");
  assert.equal((await bot().telegram.store.findSubscriber("9001")).adsConsent, true);
  assert.equal(recipients(await bot().telegram.store.readSubscribers()).length, 1);
});

test("вопрос человека уходит в группу без его имени, ответ сотрудника возвращается ему", async () => {
  sent.length = 0;
  await say("Сколько стоит покрытие на 300 метров во дворе?");
  const q = sent.find((s) => String(s.body.chat_id) === "-1001");
  assert.match(q.body.text, /Вопрос из бота<\/b> · человек пришёл из ВКонтакте/);
  assert.doesNotMatch(q.body.text, /Пётр|petr_s/);
  const relayId = messageId - 1; // сообщение в группу ушло перед ответом человеку
  sent.length = 0;
  const handled = await leadsBot.handleGroupReply({ message_id: 1, from: { id: 77 }, text: "Зависит от основания, пришлите фото.", reply_to_message: { message_id: relayId } });
  assert.equal(handled, true);
  assert.equal(sent.find((s) => String(s.body.chat_id) === "9001").body.text, "Зависит от основания, пришлите фото.");
});

test("/stop отзывает согласия и сразу удаляет данные человека", async () => {
  sent.length = 0;
  await say("/stop");
  assert.equal(await bot().telegram.store.findSubscriber("9001"), undefined);
  assert.ok(!lines("leads.jsonl").some((l) => l.tgUserId === "9001"));
  assert.ok(!readFileSync(path.join(DATA, "leads", "leads.jsonl"), "utf8").includes("Смирнов"));
  const withdrawn = lines("consents.jsonl").filter((c) => c.user === "9001" && c.action === "withdrawn").map((c) => c.kind).sort();
  assert.deepEqual(withdrawn, ["ads", "pd"]);
  assert.ok(sent.some((s) => s.method === "editMessageText" && /Согласие отозвано/.test(s.body.text)), "карточка заявки в группе очищена");
  assert.ok(sent.some((s) => String(s.body.chat_id) === "-1001" && /удалите их/.test(s.body.text || "")), "сотрудников просят удалить контакты у себя");
  assert.match(lastText(9001), /Бот остановлен/);
  assert.equal(lines("erasure.jsonl").length, 1);
});

test("удаление по телефону находит и заявку с формы, и запись бота", () => {
  const data = {
    leads: [{ id: "L1", phone: "+79991112233" }, { id: "L2", tgUserId: "5", phone: "" }, { id: "L3", phone: "89990000001" }],
    cards: [{ leadId: "L1", phone: "+79991112233" }, { leadId: "L2", tgUserId: "5" }],
    subscribers: [{ id: "5", phone: "" }, { id: "6", phone: "8 (999) 111-22-33" }],
    events: [{ event: { from: "6", text: "вопрос" } }, { event: { from: "5", text: "другой" } }],
    relay: [{ tgUserId: "6", messageId: 1 }],
  };
  const r = select({ phone: "8 999 111 22 33" }, data);
  assert.deepEqual([...r.leadIds], ["L1"]);
  assert.deepEqual([...r.users], ["6"]);
  assert.deepEqual(r.keep.leads.map((l) => l.id), ["L2", "L3"]);
  assert.deepEqual(r.keep.subscribers.map((s) => s.id), ["5"]);
  assert.equal(r.keep.events.length, 1);
  assert.equal(r.keep.relay.length, 0);
  assert.equal(erase({ user: "никого" }, { dry: true }).removed, 0);
});

test("снимок для оператора: телефоны, почта и аккаунты вычищены, воронка только счётом", () => {
  assert.equal(mask("Позвоните +7 (999) 111-22-33 или a.b@mail.ru, я @ivan_petrov, vk https://vk.com/ivan"), "Позвоните [телефон] или [почта], я [аккаунт], vk [ссылка на профиль]");
  const now = Date.parse("2026-10-10T12:00:00Z");
  const f = funnel({
    now,
    clicks: [{ at: "2026-10-09T10:00:00Z", c: "yt", slug: "priemka", device: "mobile" }, { at: "2026-10-09T10:00:00Z", c: "yt", device: "robot" }],
    leads: [{ id: "L1", createdAt: "2026-10-09T11:00:00Z", source: "ecopolis:yt", needTitle: "Покрытие", name: "Анна", phone: "+7999" }],
    leadCards: [{ leadId: "L1", status: "taken" }],
    subscribers: [{ id: "1", subscribedAt: "2026-10-09T09:00:00Z", entryOrigin: "ig", tags: ["вход-ig-priemka-17841400000000001"], funnel: { material: "x", lead: "y" }, adsConsent: true, name: "Анна" }],
    igSent: [{ at: "2026-10-09T09:00:00Z", scenario: "priemka" }, { at: "2026-10-09T09:00:00Z", failed: true }],
  });
  assert.equal(f.clicks.total, 1);
  assert.deepEqual(f.bot.byEntry, { "ig-priemka": 1 }, "личный хвост метки в снимок не идёт");
  assert.deepEqual(f.leads.byStatus, { taken: 1 });
  assert.equal(f.keywords.failed, 1);
  assert.doesNotMatch(JSON.stringify(f), /Анна|7999|17841400000000001/);
  const q = questions([{ at: "2026-10-09T10:00:00Z", event: { kind: "message", from: "1", text: "Какая толщина нужна под качели? Мой номер 89991112233" } }, { at: "2026-10-09T10:00:00Z", event: { kind: "entry", from: "1", key: "vk-priemka" } }, { at: "2026-10-09", event: { kind: "message", text: "спасибо" } }]);
  assert.equal(q.length, 1);
  assert.deepEqual(q[0], { day: "2026-10-09", text: "Какая толщина нужна под качели? Мой номер [телефон]" });
});

test("кодовое слово: короткая просьба получает материал, длинная реплика считается разговором", () => {
  const b = bot();
  const event = (text, kind = "комментарий") => ({ id: "com-1", вид: kind, текст: text, отId: "17841400000000001" });
  const r = buildReply(b, event("приёмка"));
  assert.equal(r.scenario, "priemka");
  assert.match(r.text, /https:\/\/t\.me\/eco_test_bot\?start=ig-priemka-17841400000000001/);
  assert.equal(r.publicReply, "Отправили чек-лист в личные сообщения.");
  assert.deepEqual(r.recipient, { comment_id: "1" });
  assert.equal(buildReply(b, event("Расход")).scenario, "rashod");
  assert.equal(buildReply(b, event("а у нас приёмка была в прошлом году, подрядчик всё сделал нормально, претензий нет")), null);
  assert.equal(buildReply(b, event("приёмка товара на складе")), null, "чужой оборот сценарий не трогает");
  assert.equal(buildReply(b, event("толщина")), null, "выключенный сценарий не отвечает");
  assert.deepEqual(buildReply(b, event("ПРИЁМКА", "директ")).recipient, { id: "17841400000000001" });
});

test("опрос комментариев: первый проход только запоминает, свои комментарии пропускаются", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  const feed = [{ id: "m1", timestamp: "2026-10-09T10:00:00Z", comments_count: 3 }, { id: "m2", timestamp: "2026-10-09T10:00:00Z", comments_count: 0 }, { id: "old", timestamp: "2026-08-01T10:00:00Z", comments_count: 9 }];
  const first = plan({ media: {}, primed: false }, feed, now);
  assert.deepEqual(first.toRead, ["m1"], "старше месяца и без комментариев не читаем");
  const second = plan({ primed: true, media: { m1: { count: 3, seen: ["c1"] }, m2: { count: 0, seen: [] }, gone: { count: 1, seen: [] } } }, feed, now);
  assert.deepEqual(second.toRead, [], "счётчик не вырос — вызова нет");
  assert.equal(second.next.media.gone, undefined, "публикация, выпавшая из ленты, забывается");
  const e = toEvent({ id: "c7", text: " приёмка ", from: { id: "555", username: "ivan" }, timestamp: "2026-10-10T11:00:00Z" }, "m1", "999", "ecopolis_kzn");
  assert.equal(e.id, "com-c7");
  assert.equal(e["вид"], "комментарий");
  assert.equal(toEvent({ id: "c8", text: "спасибо", username: "Ecopolis_KZN" }, "m1", "999", "ecopolis_kzn"), null);
  assert.equal(toEvent({ id: "c9", text: "" }, "m1", "999", ""), null);
});
