// Сервер, релей и дубль расписания: кто кого пускает и что куда уходит. Сеть подменена.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const DATA = mkdtempSync(path.join(os.tmpdir(), "zavod-server-"));
process.env.DATA_DIR = DATA;
process.env.ZAVOD_ENV_FILE = path.join(DATA, "нет-такого.env");
process.env.TG_BOT_TOKEN = "test-token";
process.env.TG_BOT_USERNAME = "eco_test_bot";
process.env.TG_GROUP_ID = "-1001";
process.env.APPROVER_IDS = "42";
process.env.TG_WEBHOOK_SECRET = "hook-secret-0123456789";
process.env.ADMIN_API_TOKEN = "admin-key-0123456789";
process.env.IG_FORWARD_SECRET = "pair-secret-0123456789";
process.env.IG_WEBHOOK_VERIFY_TOKEN = "verify-me";
process.env.IG_USER_ID = "17841400000000099";
process.env.PUBLIC_BASE_URL = "https://go.example.ru";
delete process.env.TG_RELAY_URL;
delete process.env.IG_RELAY_URL;
delete process.env.IG_APP_SECRET;

const sent = [];
globalThis.fetch = async (url, init) => {
  sent.push({ url: String(url), body: init?.body && typeof init.body === "string" ? init.body : "" });
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
};

const { createHandler, docHtml } = await import("../src/server.mjs");
const { handle } = await import("../ops/relay/relay.mjs");
const { judge, renderSchedule } = await import("../src/queue/mirror.mjs");
const handler = createHandler();

/** Запрос к обработчику без сети: поддельные req и res. */
function call({ method = "GET", url, headers = {}, body = "" }) {
  return new Promise((resolve, reject) => {
    const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method, url, headers, socket: { remoteAddress: "127.0.0.1" } });
    const res = {
      status: 0, headers: {}, body: "", headersSent: false,
      writeHead(status, h = {}) { this.status = status; this.headers = h; this.headersSent = true; },
      end(b = "") { this.body = String(b); resolve(this); },
    };
    handler(req, res).catch(reject);
  });
}
const json = (res) => JSON.parse(res.body);

test("живость: какие ключи заданы видно, значений нет", async () => {
  const res = await call({ url: "/health" });
  assert.equal(res.status, 200);
  const data = json(res);
  assert.equal(data.ok, true);
  assert.equal(data.configured.ADMIN_API_TOKEN, true);
  assert.equal(data.configured.THREADS_TOKEN, false);
  assert.doesNotMatch(res.body, /admin-key|hook-secret|pair-secret/);
});

test("обновления Telegram принимаются только с секретом релея", async () => {
  const update = JSON.stringify({ update_id: 1 });
  assert.equal((await call({ method: "POST", url: "/tg/update", body: update })).status, 401);
  assert.equal((await call({ method: "POST", url: "/tg/update", headers: { "x-telegram-bot-api-secret-token": "не тот секрет 0123456" }, body: update })).status, 401);
  const ok = await call({ method: "POST", url: "/tg/update", headers: { "x-telegram-bot-api-secret-token": "hook-secret-0123456789" }, body: update });
  assert.equal(ok.status, 200);
  // Битое тело тоже получает 200: иначе Telegram будет повторять его без конца.
  assert.equal((await call({ method: "POST", url: "/tg/update", headers: { "x-telegram-bot-api-secret-token": "hook-secret-0123456789" }, body: "{не json" })).status, 200);
});

test("команды очереди: без ключа оператора отказ с кодом поломки", async () => {
  const no = await call({ method: "POST", url: "/admin/queue", body: JSON.stringify({ cmd: "list" }) });
  assert.equal(no.status, 401);
  assert.equal(json(no).code, 2);
  const bad = await call({ method: "POST", url: "/admin/queue", headers: { authorization: "Bearer admin-key-0123456780" }, body: JSON.stringify({ cmd: "list" }) });
  assert.equal(bad.status, 401);
  const ok = await call({ method: "POST", url: "/admin/queue", headers: { authorization: "Bearer admin-key-0123456789" }, body: JSON.stringify({ cmd: "list" }) });
  assert.equal(ok.status, 200);
  assert.deepEqual(json(ok), { code: 0, lines: ["очередь пуста"], data: [] });
  const garbage = await call({ method: "POST", url: "/admin/queue", headers: { authorization: "Bearer admin-key-0123456789" }, body: "не json" });
  assert.equal(garbage.status, 400);
});

test("неизвестная команда очереди — отказ по правилу, а не падение сервера", async () => {
  const res = await call({ method: "POST", url: "/admin/queue", headers: { authorization: "Bearer admin-key-0123456789" }, body: JSON.stringify({ cmd: "снести-всё" }) });
  assert.equal(res.status, 200);
  assert.notEqual(json(res).code, 0);
});

test("короткая ссылка отвечает переадресацией на сайт клиента", async () => {
  const res = await call({ url: "/go/priemka?c=yt&p=val-2", headers: { "user-agent": "Mozilla/5.0" } });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^https:\/\/ecopolisrf\.ru\//);
  assert.match(res.headers.location, /utm_source=yt/);
});

test("форма заявки: страница открывается, отправка без согласия отклоняется", async () => {
  const page = await call({ url: "/z/raschet?c=vk" });
  assert.equal(page.status, 200);
  assert.match(page.body, /<form/);
  assert.match(page.headers["content-type"], /text\/html/);
  const no = await call({ method: "POST", url: "/z/raschet", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ name: "Анна", phone: "+79991112233" }).toString() });
  assert.equal(no.status, 400);
});

test("тексты согласий отдаются страницей, чужой путь наружу не выводит", async () => {
  const ok = await call({ url: "/doc/soglasie" });
  assert.equal(ok.status, 200);
  assert.match(ok.body, /<h1>/);
  assert.match(ok.body, /noindex/);
  assert.equal((await call({ url: "/doc/net-takogo" })).status, 404);
  assert.equal((await call({ url: "/doc/..%2F..%2Fpackage" })).status, 404);
  assert.equal((await call({ url: "/doc/" })).status, 404);
});

test("страница согласия: таблица строится, разметка из текста не исполняется", () => {
  const html = docHtml("# Согласие\n\nТекст <script>alert(1)</script>\n\n| Цель | Срок |\n|---|---|\n| Ответ на заявку | 3 года |\n\n- первое\n- второе");
  assert.match(html, /<title>Согласие<\/title>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<th>Цель<\/th><th>Срок<\/th>/);
  assert.match(html, /<td>Ответ на заявку<\/td><td>3 года<\/td>/);
  assert.match(html, /<ul><li>первое<\/li><li>второе<\/li><\/ul>/);
});

test("возврат после входа ВКонтакте: код показан человеку, лишнее из адреса вычищено", async () => {
  const res = await call({ url: "/cb/vk?code=vk2.a.AbC-123_x<script>&device_id=dev%20ice\"1" });
  assert.equal(res.status, 200);
  assert.match(res.body, /<code>vk2\.a\.AbC-123_xscript<\/code>/);
  assert.match(res.body, /<code>device1<\/code>/);
  assert.doesNotMatch(res.body, /<script>/);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.match((await call({ url: "/cb/vk" })).body, /Вход не выполнен/);
});

test("подписка Instagram подтверждается только своим словом", async () => {
  const ok = await call({ url: "/ig/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body, "12345");
  assert.equal((await call({ url: "/ig/webhook?hub.mode=subscribe&hub.verify_token=чужое&hub.challenge=12345" })).status, 403);
});

test("события Instagram: без подписи отказ, с подписью пары принимаются", async () => {
  const body = JSON.stringify({ object: "instagram", entry: [{ id: "17841400000000099", time: 1, changes: [{ field: "comments", value: { id: "c1", text: "приёмка", from: { id: "555", username: "ivan" }, media: { id: "m1" } } }] }] });
  assert.equal((await call({ method: "POST", url: "/ig/webhook", body })).status, 401);
  assert.equal((await call({ method: "POST", url: "/ig/webhook", headers: { "x-forward-signature": "sha256=00" }, body })).status, 401);
  const sign = (secret) => `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
  // Подпись секретом чужого приложения не подходит: ключ пары у каждого клиента свой.
  assert.equal((await call({ method: "POST", url: "/ig/webhook", headers: { "x-forward-signature": sign("секрет другого клиента") }, body })).status, 401);
  const ok = await call({ method: "POST", url: "/ig/webhook", headers: { "x-forward-signature": sign("pair-secret-0123456789") }, body });
  assert.equal(ok.status, 200);
  assert.equal(json(ok).ok, true);
});

test("неизвестный адрес — 404, а не страница с подсказками", async () => {
  const res = await call({ url: "/admin" });
  assert.equal(res.status, 404);
  assert.deepEqual(json(res), { ok: false });
});

/* ───────────────────────────── релей ───────────────────────────── */

const RELAY = { TG_BOT_TOKEN: "111:SECRET-BOT-TOKEN", TG_RELAY_SECRET: "relay-secret-0123456789", TG_WEBHOOK_SECRET: "hook-secret-0123456789", IG_RELAY_SECRET: "ig-relay-secret-01234", ORIGIN_URL: "https://zavod.example.ru/" };
const fake = (status = 200, body = { ok: true, result: { message_id: 7 } }) => {
  const calls = [];
  const doFetch = async (url, init = {}) => { calls.push({ url: String(url), method: init.method, headers: init.headers || {}, body: init.body }); return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "set-cookie": "a=b" } }); };
  return { calls, doFetch };
};
const R = (pathname, init = {}) => new Request(`https://relay.example.net${pathname}`, init);

test("релей: обновление Telegram без секрета не проходит, с секретом уходит на сервер завода", async () => {
  const f = fake();
  const body = JSON.stringify({ update_id: 5, message: { text: "привет" } });
  assert.equal((await handle(R("/tg/webhook", { method: "POST", body }), RELAY, f.doFetch)).status, 401);
  assert.equal(f.calls.length, 0);
  const ok = await handle(R("/tg/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": RELAY.TG_WEBHOOK_SECRET }, body }), RELAY, f.doFetch);
  assert.equal(ok.status, 200);
  assert.equal(f.calls[0].url, "https://zavod.example.ru/tg/update");
  assert.equal(f.calls[0].body, body);
  assert.equal(f.calls[0].headers["x-telegram-bot-api-secret-token"], RELAY.TG_WEBHOOK_SECRET);
});

test("релей: сервер завода лежит — Telegram получает 502 и повторит обновление сам", async () => {
  const down = fake(500, { ok: false });
  const res = await handle(R("/tg/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": RELAY.TG_WEBHOOK_SECRET }, body: "{}" }), RELAY, down.doFetch);
  assert.equal(res.status, 502);
  const dead = await handle(R("/tg/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": RELAY.TG_WEBHOOK_SECRET }, body: "{}" }), RELAY, async () => { throw new Error("ECONNREFUSED"); });
  assert.equal(dead.status, 502);
});

test("релей: вызов Bot API подставляет токен бота, наружу токен не возвращается", async () => {
  const f = fake();
  const body = JSON.stringify({ chat_id: -1001, text: "карточка" });
  assert.equal((await handle(R("/api/sendMessage", { method: "POST", body }), RELAY, f.doFetch)).status, 401);
  assert.equal((await handle(R("/api/sendMessage", { method: "POST", headers: { "x-relay-secret": "relay-secret-0123456780" }, body }), RELAY, f.doFetch)).status, 401);
  const res = await handle(R("/api/sendMessage", { method: "POST", headers: { "x-relay-secret": RELAY.TG_RELAY_SECRET }, body }), RELAY, f.doFetch);
  assert.equal(res.status, 200);
  assert.equal(f.calls[0].url, "https://api.telegram.org/bot111:SECRET-BOT-TOKEN/sendMessage");
  assert.equal(f.calls[0].body, body);
  const text = await res.text();
  assert.doesNotMatch(text, /SECRET-BOT-TOKEN/);
  assert.equal(res.headers.get("set-cookie"), null, "чужие заголовки ответа через релей не проходят");
});

test("релей: имя метода — только буквы, чужой путь в адрес Telegram не попадает", async () => {
  const f = fake();
  const h = { "x-relay-secret": RELAY.TG_RELAY_SECRET };
  for (const p of ["/api/send-Message", "/api/getMe/../x", "/api/a", "/api/getFile%2F..", "/apix/sendMessage"]) {
    assert.equal((await handle(R(p, { method: "POST", headers: h, body: "{}" }), RELAY, f.doFetch)).status, 404, p);
  }
  assert.equal(f.calls.length, 0);
});

test("релей: вызов Instagram берёт маркер из заголовка и не даёт подменить его в адресе", async () => {
  const f = fake(200, { data: [] });
  const h = { "x-relay-secret": RELAY.IG_RELAY_SECRET };
  assert.equal((await handle(R("/ig/v23.0/me/media?fields=id"), RELAY, f.doFetch)).status, 401);
  assert.equal((await handle(R("/ig/v23.0/me/media?fields=id", { headers: h }), RELAY, f.doFetch)).status, 400, "без маркера вызов не уходит");
  const res = await handle(R("/ig/v23.0/me/media?fields=id&access_token=чужой", { headers: { ...h, "x-ig-token": "IGTOKEN123" } }), RELAY, f.doFetch);
  assert.equal(res.status, 200);
  const target = new URL(f.calls[0].url);
  assert.equal(target.origin + target.pathname, "https://graph.instagram.com/v23.0/me/media");
  assert.equal(target.searchParams.get("fields"), "id");
  assert.deepEqual(target.searchParams.getAll("access_token"), ["IGTOKEN123"]);
  assert.equal(f.calls[0].body, undefined, "у запроса на чтение тела нет");
  // Секрет Telegram к Instagram не подходит, когда у Instagram задан свой.
  assert.equal((await handle(R("/ig/v23.0/me", { headers: { "x-relay-secret": RELAY.TG_RELAY_SECRET, "x-ig-token": "t" } }), RELAY, f.doFetch)).status, 401);
});

test("релей: тело ответа на комментарий уходит в Instagram как пришло", async () => {
  const f = fake(200, { id: "reply-1" });
  const body = JSON.stringify({ message: "Отправили чек-лист в личные сообщения." });
  const res = await handle(R("/ig/v23.0/1789/replies", { method: "POST", headers: { "x-relay-secret": RELAY.IG_RELAY_SECRET, "x-ig-token": "IGTOKEN123", "content-type": "application/json" }, body }), RELAY, f.doFetch);
  assert.equal(res.status, 200);
  assert.equal(f.calls[0].method, "POST");
  assert.equal(f.calls[0].body, body);
});

test("релей: живость и неизвестный адрес", async () => {
  assert.equal((await handle(R("/health"), RELAY)).status, 200);
  assert.equal((await handle(R("/"), RELAY)).status, 404);
  assert.equal((await handle(R("/tg/webhook"), RELAY)).status, 404, "проверка адреса запросом GET ничего не раскрывает");
});

/* ───────────────────────────── дубль расписания ───────────────────────────── */

test("сторож: сервер молчит, выпуск стоит, копия устарела — три разные тревоги", () => {
  const now = Date.parse("2026-10-12T09:00:00Z");
  const beat = (min) => ({ runnerAt: new Date(now - min * 60_000).toISOString() });
  assert.equal(judge({ health: null, copyAgeMin: 0, now }).key, "server:down");
  assert.equal(judge({ health: beat(25), copyAgeMin: 0, now }).key, "server:runner");
  assert.match(judge({ health: beat(25), copyAgeMin: 0, now }).text, /25 мин/);
  assert.equal(judge({ health: {}, copyAgeMin: 0, now }).key, "server:runner", "выпуск ни разу не отметился");
  assert.equal(judge({ health: beat(3), copyAgeMin: 120, now }).key, "mirror:stale");
  assert.equal(judge({ health: beat(3), copyAgeMin: 10, now }).key, "");
  assert.equal(judge({ health: null, copyAgeMin: 500, now, takeover: true }).key, "", "при перехвате молчание сервера известно");
});

test("расписание для человека: по дням, снятое скрыто, неодобренное и сбои отдельными списками", () => {
  const now = Date.parse("2026-10-12T06:00:00Z"); // понедельник, 09:00 по Москве
  const e = (over) => ({ id: over.name, channel: "threads", kind: "thread", status: "approved", date: "2026-10-12", time: "19:00", material: "blog:priemka", posts: ["Площадку во дворе приняли за пять минут | и зря.", "Толщину никто не мерил."], ...over });
  const md = renderSchedule([
    e({ name: "a" }),
    e({ name: "b", channel: "youtube", kind: "video", date: "2026-10-13", time: "10:00", title: "Прораб положил покрытие в дождь", text: "Описание" }),
    e({ name: "c", status: "cancelled" }),
    e({ name: "d", status: "review", date: "2026-10-14" }),
    e({ name: "f", status: "failed", date: "2026-10-11", note: "площадка ответила отказом" }),
    e({ name: "g", date: "2026-11-20" }),
  ], now, { threads: "Threads", youtube: "YouTube" }, { stopped: true });
  assert.match(md, /Копия с сервера на 2026-10-12 09:00 по Москве\. \*\*Выпуск на сервере остановлен \(STOP\)\.\*\*/);
  assert.match(md, /## 12\.10, понедельник/);
  assert.match(md, /## 13\.10, вторник/);
  assert.match(md, /\| 10:00 \| YouTube \|/);
  assert.match(md, /за пять минут \/ и зря/, "черта в тексте не ломает таблицу");
  assert.match(md, /## Не одобрено\n\n- 2026-10-14 19:00 · Threads/);
  assert.match(md, /## Требуют решения\n\n- 2026-10-11 19:00 · Threads .* площадка ответила отказом/);
  assert.doesNotMatch(md, /2026-11-20/, "дальше двух недель расписание не показывает");
  assert.equal((md.match(/\| 19:00 \| Threads \|/g) || []).length, 2, "снятая запись в таблицу не попала");
  assert.match(renderSchedule([], now), /в очереди пусто/);
});

test("незаданный ключ оператора ручку не открывает", async () => {
  // Сервер подняли, а ключ в .env забыли: пустая строка не должна совпасть с пустой строкой.
  const before = process.env.ADMIN_API_TOKEN;
  process.env.ADMIN_API_TOKEN = "";
  try {
    const res = await call({ method: "POST", url: "/admin/queue", headers: { authorization: "Bearer " }, body: JSON.stringify({ cmd: "list" }) });
    assert.equal(res.status, 401);
  } finally {
    process.env.ADMIN_API_TOKEN = before;
  }
});
