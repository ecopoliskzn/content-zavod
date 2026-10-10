// Аварийный перехват расписания: две машины в одном процессе. Каталог данных сервера и
// каталог компьютера оператора лежат рядом, «сеть» между ними — подменённый fetch, который
// исполняет команду очереди в каталоге сервера. Так проверяется главное правило перехвата:
// выпускает всегда кто-то один, а слово человека доходит до обеих машин.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVER = mkdtempSync(path.join(os.tmpdir(), "zavod-srv-"));
const PC = mkdtempSync(path.join(os.tmpdir(), "zavod-pc-"));
process.env.MIRROR_DIR = mkdtempSync(path.join(os.tmpdir(), "zavod-mirror-"));
process.env.ZAVOD_ENV_FILE = path.join(SERVER, "нет-такого.env");
process.env.TG_BOT_TOKEN = "test-token";
process.env.TG_GROUP_ID = "-1001";
process.env.APPROVER_IDS = "42";
process.env.ADMIN_API_TOKEN = "ключ-оператора";
delete process.env.TG_RELAY_URL;

const API = "https://zavod.test";
const onServer = () => { process.env.DATA_DIR = SERVER; delete process.env.QUEUE_API_BASE; };
const onPc = () => { process.env.DATA_DIR = PC; process.env.QUEUE_API_BASE = API; };
const asServer = async (fn) => { onServer(); try { return await fn(); } finally { onPc(); } };
onServer();

const store = await import("../src/queue/store.mjs");
const ledger = await import("../src/queue/ledger.mjs");
const { execute } = await import("../src/queue/commands.mjs");
const { runOnce } = await import("../src/queue/runner.mjs");
const { handback, pull, takeover } = await import("../src/queue/mirror.mjs");
const { stopState } = await import("../src/queue/switch.mjs");
const { submit, handleCallback } = await import("../src/bot/approval.mjs");
const staff = await import("../src/bot/staff.mjs");
const { _setAdapter } = await import("../src/channels/index.mjs");
const { dueAt } = await import("../src/lib/time.mjs");

/* Сеть. mode: up — сервер отвечает; down — молчит; 401 — отвечает отказом; 502 — веб-сервер
   жив, а завод за ним нет. budget — сколько запросов к серверу пройдёт до обрыва. */
const net = { mode: "up", budget: Infinity };
const sent = [];
let messageId = 900;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith(API)) {
    if (net.mode === "down" || net.budget <= 0) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    net.budget--;
    if (net.mode === "502") return new Response("<html>502 Bad Gateway</html>", { status: 502 });
    if (net.mode === "401") return new Response(JSON.stringify({ code: 2, lines: ["ключ оператора не подошёл"] }), { status: 401 });
    const payload = JSON.parse(init.body);
    return asServer(async () => new Response(JSON.stringify(await execute(payload.cmd, payload.args || {}, payload.actor)), { status: 200 }));
  }
  const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : {};
  sent.push({ method: u.split("/").pop(), body });
  return new Response(JSON.stringify({ ok: true, result: { message_id: ++messageId, chat: { id: -1001 } } }), { status: 200 });
};
const said = () => sent.map((s) => s.body.text || "").join("\n");

/* Площадки-заглушки. Ветка «e-chastichno» рвётся после первой реплики. */
const calls = [];
const plan = { "e-chastichno": () => ({ ok: false, error: "сеть оборвалась", retry: true, done: ["e1"], link: "https://www.threads.net/@eco/post/e1" }) };
_setAdapter("threads", { name: "threads", publish: async (entry) => { calls.push({ name: entry.name, where: process.env.DATA_DIR === PC ? "компьютер" : "сервер", done: entry.done || [] }); return (plan[entry.name] || (() => ({ ok: true, id: `id-${entry.name}`, link: `https://www.threads.net/@eco/post/${entry.name}`, done: [`id-${entry.name}`] })))(entry); } });
_setAdapter("dzen", { name: "dzen", publish: async (entry, ctx) => { await ctx.onState({ packageMessageId: 7100 }); return { ok: true, manual: true, note: "пакет отправлен в группу" }; } });

const withFlags = async (flags, fn) => {
  const add = flags.map((f) => `--${f}`);
  process.argv.push(...add);
  try { return await fn(); } finally { for (const a of add) process.argv.splice(process.argv.indexOf(a), 1); }
};
const press = (data) => handleCallback({ id: "cb", data, from: { id: 42, first_name: "Анна" } });
const command = (text) => staff.handleCommand({ text, chat: { id: -1001 }, from: { id: 42, first_name: "Анна" } });
const thread = (name, date, time, posts) => ({ channel: "threads", kind: "thread", name, material: "blog:primer", date, time, posts: posts || [`«${name}»: подрядчик в Казани сдал площадку, а через год она крошится.`, "Причина нашлась в акте: толщину никто не мерил."] });
const approved = async (raw) => {
  const { entry } = await store.put(raw, "S1");
  await submit(entry.id, "S1");
  await press(`q:ok:${entry.id}`);
  return store.get(entry.id);
};
const local = (id) => asPc(() => store.get(id));
const asPc = (fn) => { onPc(); return fn(); };
const T = (date, time, min = 0) => dueAt({ date, time }) + min * 60_000;

const ids = {};

test("перехват при живом сервере: остановка принята, копия свежая, запись со слотом до перехвата подтверждена сервером", async () => {
  await asServer(async () => {
    ids.a = (await approved(thread("a-do-perehvata", "2030-03-12", "19:00"))).id;
    ids.b = (await approved(thread("b-snimut", "2030-03-13", "14:30"))).id;
    ids.d = (await approved({ channel: "dzen", kind: "article", name: "d-paket", material: "blog:primer", date: "2030-03-14", time: "11:00", title: "Где покрытие отслаивается чаще всего", text: "Примыкания относятся к самым уязвимым местам резинового покрытия. ".repeat(14) })).id;
    ids.f = (await approved(thread("f-otzovut", "2030-03-14", "14:30"))).id;
    ids.e = (await approved(thread("e-chastichno", "2030-03-15", "19:00", ["«e-chastichno»: площадку в Казани сдали в срок.", "Через год по ней пошли трещины.", "Причина нашлась в акте приёмки."]))).id;
    const c = (await store.put({ channel: "telegram", kind: "post", name: "c-snimet-operator", material: "blog:primer", date: "2030-03-13", time: "10:00", text: "Площадку в Казани приняли после дождя." }, "S1")).entry;
    await store.transition(c.id, "review", {}, "S1");
    await store.transition(c.id, "approved", { approval: { by: 42, name: "Анна", at: new Date().toISOString() } }, "tg:42");
    ids.c = c.id;
    const n = (await store.put(thread("n-novoe-da", "2030-03-16", "14:30"), "S1")).entry;
    await submit(n.id, "S1");
    ids.n = n.id;
  });
  onPc();
  assert.equal((await pull()).ok, true);

  // Без копии и без --yes перехвата нет; ключ не подошёл — сервер жив, перехвата тоже нет.
  assert.equal((await takeover()).code, 1);
  net.mode = "401";
  const refused = await withFlags(["yes"], () => takeover({ now: T("2030-03-12", "19:00", 5) }));
  assert.equal(refused.code, 2);
  assert.match(refused.lines.join("\n"), /ключ оператора не подошёл/);
  assert.match(refused.lines.join("\n"), /сервер жив и остановку не принял/);
  assert.equal(existsSync(path.join(PC, "TAKEOVER.json")), false);
  net.mode = "up";

  // Выпуск остановил человек: перехватывать нечего.
  await asServer(() => execute("pause", { reason: "ждём юриста" }, "оператор"));
  const human = await withFlags(["yes"], () => takeover({ now: T("2030-03-12", "19:00", 5) }));
  assert.equal(human.code, 1);
  assert.match(human.lines.join("\n"), /остановлен человеком/);
  assert.equal(existsSync(path.join(PC, "TAKEOVER.json")), false);
  await asServer(() => execute("resume", {}, "оператор"));

  const took = await withFlags(["yes"], () => takeover({ now: T("2030-03-12", "19:00", 5) }));
  assert.equal(took.code, 0, took.lines.join("\n"));
  const text = took.lines.join("\n");
  assert.match(text, /сервер ответил и остановлен/);
  assert.match(text, /копия расписания снята заново/);
  assert.match(text, /возвращено в расписание: a-do-perehvata/);
  assert.doesNotMatch(text, /откройте площадку/, "сервер на связи: смотреть площадку глазами не нужно");
  assert.deepEqual(await asServer(() => [stopState().takeover, stopState().human]), [true, false]);
  assert.equal(local(ids.a).status, "approved");
  assert.equal(local(ids.a).takeoverHold, undefined);

  // Второй перехват поверх идущего переписал бы местное расписание копией.
  const twice = await withFlags(["yes"], () => takeover());
  assert.equal(twice.code, 1);
  assert.match(twice.lines.join("\n"), /перехват уже идёт/);
});

test("во время перехвата: «Снять» и «стоп» человека доходят до компьютера, новое «да» ждёт возврата", async () => {
  // Утверждающий снимает запись кнопкой: бот не обещает «Не выйдет», а говорит, как есть.
  sent.length = 0;
  await asServer(() => press(`q:no:${ids.b}`));
  assert.match(said(), /Расписание сейчас ведёт компьютер оператора: о вашем решении он узнаёт при сверке/);
  assert.doesNotMatch(said(), /Не выйдет\./);
  // Новое согласие компьютер не принимает: запись выйдет после возврата.
  sent.length = 0;
  await asServer(() => press(`q:ok:${ids.n}`));
  assert.match(said(), /новые согласия он не принимает/);

  onPc();
  const first = await runOnce({ now: T("2030-03-12", "19:00", 6) });
  assert.deepEqual(first.published, ["a-do-perehvata"]);
  assert.equal(local(ids.b).status, "cancelled", "снятое на сервере снято и на компьютере");
  assert.equal(local(ids.n).status, "review", "новое «да» компьютеру не известно");
  assert.ok(asPc(() => ledger.rows()).some((r) => r.id === ids.a && r.status === "published" && r.takeover), "строка журнала помечена: вышла при перехвате");

  // «Стоп» человека при перехвате ставится и доходит до компьютера при ближайшей сверке.
  sent.length = 0;
  await asServer(() => command("/stop_release"));
  assert.match(sent.at(-1).body.text, /Выпуск остановлен\. Расписание сейчас ведёт компьютер оператора/);
  assert.deepEqual(await asServer(() => [stopState().human, stopState().takeover]), [true, true]);
  const stopped = await runOnce({ now: T("2030-03-12", "19:00", 12) });
  assert.equal(stopped.stopped, true);
  assert.equal(asPc(() => stopState().human), true);

  // «Старт» снимает слово человека, но не перехват: сервер молчит, компьютер продолжает.
  sent.length = 0;
  await asServer(() => command("/start_release"));
  assert.match(sent.at(-1).body.text, /Остановка снята\. Расписание всё ещё ведёт компьютер оператора/);
  assert.deepEqual(await asServer(() => [stopState().human, stopState().takeover]), [false, true]);
  const resumed = await runOnce({ now: T("2030-03-12", "19:00", 18) });
  assert.notEqual(resumed.stopped, true);
  assert.equal(asPc(() => stopState().stopped), false);

  // Сервер во время перехвата сам не выпускает ничего.
  const serverRun = await asServer(() => runOnce({ now: T("2030-03-14", "14:30", 1) }));
  assert.equal(serverRun.stopped, true);
  assert.deepEqual(serverRun.published, []);
});

test("возврат: серверу передаётся вышедшее, пакеты, начатое и снятое; обрыв посреди возврата ничего не задваивает", async () => {
  onPc();
  // Пакет на ручную выкладку, обычная ветка, оборванная ветка.
  assert.deepEqual((await runOnce({ now: T("2030-03-14", "11:00", 1) })).handed, ["d-paket"]);
  assert.deepEqual((await runOnce({ now: T("2030-03-14", "14:30", 1) })).published, ["f-otzovut"]);
  assert.deepEqual((await runOnce({ now: T("2030-03-15", "19:00", 1) })).retry, ["e-chastichno"]);
  assert.deepEqual(local(ids.e).done, ["e1"]);
  // Оператор снимает запись на компьютере по просьбе утверждающего.
  assert.equal((await execute("cancel", { ref: ids.c, reason: "попросил утверждающий" }, "оператор")).code, 0);
  // А на сервере утверждающий отозвал согласие на ветку, которую компьютер уже выпустил.
  await asServer(() => press(`q:undo:${ids.f}`));

  // Первый заход рвётся после двух запросов: сервер узнал об одной записи из пяти.
  net.budget = 2;
  const broken = await handback({ waitMs: 200 });
  assert.equal(broken.code, 2);
  assert.match(broken.lines.join("\n"), /Выпуск на сервере НЕ включён/);
  assert.equal(existsSync(path.join(PC, "TAKEOVER.json")), true, "перехват не снят");
  assert.equal(await asServer(() => stopState().takeover), true, "сервер по-прежнему стоит");
  assert.equal(asPc(() => stopState().handback), true, "и компьютер на время возврата остановлен своей отметкой, слово человека не затёрто");
  assert.equal((await runOnce({ now: T("2030-03-15", "19:00", 6) })).stopped, true);

  net.budget = Infinity;
  sent.length = 0;
  const done = await handback({ waitMs: 200 });
  assert.equal(done.code, 0, done.lines.join("\n"));
  const text = done.lines.join("\n");
  assert.match(text, /вышедших 2, пакетов на ручную выкладку 1, начатых и не законченных 1, снятых 1/);
  assert.match(text, /f-otzovut — БЕЗ СОГЛАСИЯ/);
  assert.match(text, /сервер: выпуск на сервере включён/);
  assert.equal(existsSync(path.join(PC, "TAKEOVER.json")), false);

  await asServer(() => {
    assert.equal(stopState().stopped, false);
    assert.equal(store.get(ids.a).status, "published");
    assert.equal(ledger.rows().filter((r) => r.id === ids.a && r.status === "published").length, 1, "повтор возврата строку не задвоил");
    assert.equal(store.get(ids.d).status, "handed");
    assert.equal(store.get(ids.d).result.packageMessageId, 7100);
    assert.equal(ledger.rows().filter((r) => r.id === ids.d && r.status === "handed").length, 1);
    assert.deepEqual([store.get(ids.e).status, store.get(ids.e).done], ["approved", ["e1"]]);
    assert.ok(store.get(ids.e).attempts >= 1, "сервер продолжит со сверкой");
    assert.equal(store.get(ids.c).status, "cancelled");
    assert.match(store.get(ids.c).note, /снята на компьютере оператора при перехвате/);
    assert.equal(store.get(ids.f).status, "cancelled", "после нового «да» она не выйдет второй раз");
    assert.ok(ledger.rows().some((r) => r.id === ids.f && r.status === "published" && r.withoutApproval));
    assert.equal(store.get(ids.n).status, "approved");
  });
  assert.match(said(), /вышла во время аварии сервера/);

  // Задача аварийного выпуска, забытая включённой, по копии больше не выпускает.
  const idle = await runOnce({ now: T("2030-03-15", "19:00", 8) });
  assert.equal(idle.stopped, true);
  assert.match(idle.idle, /только при перехвате/);
  assert.equal((await handback()).code, 1, "повторный возврат: перехвата уже нет");

  // Сервер продолжает оборванную ветку с места обрыва, а не с первой реплики.
  delete plan["e-chastichno"];
  calls.length = 0;
  const run = await asServer(() => runOnce({ now: T("2030-03-15", "19:00", 10) }));
  assert.deepEqual(run.published, ["e-chastichno"]);
  assert.deepEqual(calls, [{ name: "e-chastichno", where: "сервер", done: ["e1"] }]);
});

test("сервер молчит: перехват только после подтверждённой остановки, вернувшийся сервер сразу получает отметку", async () => {
  await asServer(async () => {
    await execute("cancel", { ref: ids.n, reason: "прошлый пример закрыт" }, "оператор");
    ids.h = (await approved(thread("h-po-kopii", "2030-04-02", "14:30"))).id;
    ids.k = (await approved(thread("k-slot-proshel", "2030-04-01", "19:00"))).id;
  });
  onPc();
  assert.equal((await pull()).ok, true);
  const now = T("2030-04-01", "19:00", 20);

  // Веб-сервер отвечает 502: завод за ним лежит, но расписание по cron может идти.
  net.mode = "502";
  const asked = await withFlags(["yes"], () => takeover({ now }));
  assert.equal(asked.code, 1);
  assert.match(asked.lines.join("\n"), /--server-stopped/);
  assert.match(asked.lines.join("\n"), /pause --takeover/);
  assert.equal(existsSync(path.join(PC, "TAKEOVER.json")), false);

  net.mode = "down";
  const took = await withFlags(["yes", "server-stopped"], () => takeover({ now }));
  assert.equal(took.code, 0, took.lines.join("\n"));
  assert.match(took.lines.join("\n"), /остановлен со слов оператора/);
  assert.match(took.lines.join("\n"), /записей, чей слот наступил до перехвата: 1/);
  assert.match(took.lines.join("\n"), /k-slot-proshel/);
  assert.deepEqual([local(ids.k).status, local(ids.k).takeoverHold], ["failed", true]);

  // Сервер молчит: компьютер идёт по копии, придержанную запись не трогает.
  const blind = await runOnce({ now: T("2030-04-02", "14:30", 1) });
  assert.deepEqual(blind.published, ["h-po-kopii"]);
  assert.equal(local(ids.k).status, "failed");

  /* Сервер вернулся. Отметки перехвата на нём нет, стоит удержание после простоя, а
     утверждающий успел сказать «стоп». Компьютер при первой же сверке ставит отметку
     (иначе /start_release включил бы второго выпускающего) и принимает остановку. */
  await asServer(async () => {
    writeFileSync(path.join(SERVER, "HOLD"), JSON.stringify({ at: new Date().toISOString(), silentMin: 300 }));
    await command("/stop_release");
    assert.deepEqual([stopState().human, stopState().takeover], [true, false]);
  });
  net.mode = "up";
  assert.equal((await runOnce({ now: T("2030-04-02", "14:30", 6) })).stopped, true);
  assert.deepEqual(await asServer(() => [stopState().human, stopState().takeover]), [true, true]);

  // «Старт» человека: сервер остаётся под отметкой перехвата, компьютер продолжает.
  await asServer(() => command("/start_release"));
  assert.deepEqual(await asServer(() => [stopState().human, stopState().takeover]), [false, true]);
  assert.equal((await asServer(() => runOnce({ now: T("2030-04-02", "14:30", 8) }))).stopped, true, "сервер не выпускает");
  const back = await runOnce({ now: T("2030-04-02", "14:30", 11) });
  assert.notEqual(back.stopped, true);
  // Запись со слотом до перехвата: сервер её не выпускал, она возвращается в расписание.
  assert.notEqual(local(ids.k).status, "failed");
  assert.equal(local(ids.k).takeoverHold, undefined);

  const done = await handback({ waitMs: 200 });
  assert.equal(done.code, 0, done.lines.join("\n"));
  await asServer(() => {
    assert.equal(stopState().stopped, false);
    assert.equal(existsSync(path.join(SERVER, "HOLD")), false, "удержание после простоя снято возвратом");
    assert.equal(store.get(ids.h).status, "published");
  });
  assert.equal(JSON.parse(readFileSync(path.join(process.env.MIRROR_DIR, "state.json"), "utf8")).stoppedByHuman, false);
});

test("запись исправили и одобрили заново после копии: прежний текст с компьютера не выходит, а вышедший вслепую назван человеку", async () => {
  await asServer(async () => {
    ids.p = (await approved(thread("p-ispravyat", "2030-05-07", "14:30"))).id;
    ids.q = (await approved(thread("q-vyjdet-vslepuyu", "2030-05-06", "19:00"))).id;
  });
  onPc();
  assert.equal((await pull()).ok, true);
  const took = await withFlags(["yes"], () => takeover({ now: T("2030-05-06", "14:30") }));
  assert.equal(took.code, 0, took.lines.join("\n"));
  // Утверждающий вернул запись на правку, оператор исправил, утверждающий одобрил заново.
  const edit = async (id, name, date, time) => {
    await execute("add", { entries: [{ ...thread(name, date, time), posts: [`«${name}»: площадку в Казани сдали в срок, а через год по ней пошли трещины.`, "Причина нашлась в акте: толщину никто не мерил."] }] }, "S1");
    await submit(id, "S1");
    await press(`q:ok:${id}`);
    assert.equal(store.get(id).status, "approved");
  };
  const oldP = local(ids.p).contentHash;
  await asServer(() => edit(ids.p, "p-ispravyat", "2030-05-07", "14:30"));
  assert.notEqual(await asServer(() => store.get(ids.p).contentHash), oldP);

  // Сервер на связи: при сверке компьютер видит другой отпечаток и прежний текст не выпускает.
  await runOnce({ now: T("2030-05-06", "14:30", 5) });
  assert.equal(local(ids.p).status, "cancelled");
  assert.match(local(ids.p).note, /одобрен другой текст/);

  // Сервер недоступен компьютеру, а запись на нём исправили: компьютер выпускает по копии.
  net.mode = "down";
  await asServer(() => edit(ids.q, "q-vyjdet-vslepuyu", "2030-05-06", "19:00"));
  calls.length = 0;
  assert.deepEqual((await runOnce({ now: T("2030-05-06", "19:00", 1) })).published, ["q-vyjdet-vslepuyu"]);
  assert.deepEqual(calls.map((c) => c.where), ["компьютер"]);

  // Возврат: публикация записана, вторая не выйдет, а человек клиента узнаёт, что вышел прежний текст.
  net.mode = "up";
  sent.length = 0;
  const done = await handback({ waitMs: 200 });
  assert.equal(done.code, 0, done.lines.join("\n"));
  assert.match(done.lines.join("\n"), /q-vyjdet-vslepuyu — ПРЕЖНИЙ ТЕКСТ/);
  assert.match(said(), /вышла во время аварии сервера прежним текстом/);
  await asServer(() => {
    assert.equal(store.get(ids.q).status, "published");
    assert.ok(ledger.rows().some((r) => r.id === ids.q && r.status === "published" && r.otherText));
    // Исправленная запись на сервере цела: снятие на компьютере было только сверкой.
    assert.equal(store.get(ids.p).status, "approved");
  });
  // Сервер выпускает исправленную запись сам и один раз.
  calls.length = 0;
  const run = await asServer(() => runOnce({ now: T("2030-05-07", "14:30", 1) }));
  assert.deepEqual(run.published, ["p-ispravyat"]);
  assert.deepEqual(calls.map((c) => `${c.name} · ${c.where}`), ["p-ispravyat · сервер"]);
});

test("сервер поднят из архива старше копии: возврат не застревает, вышедшее записано в журнал, пропавшее названо", async () => {
  await asServer(async () => {
    ids.x = (await approved(thread("x-vyshla-bez-servera", "2030-06-03", "14:30"))).id;
    ids.z = (await approved({ channel: "dzen", kind: "article", name: "z-paket-bez-servera", material: "blog:primer", date: "2030-06-06", time: "11:00", title: "Как принять покрытие у подрядчика", text: "Приёмку покрытия ведут по акту, а не на глаз. ".repeat(20) })).id;
    ids.v = (await approved(thread("v-zhdala-vyhoda", "2030-06-10", "14:30"))).id;
  });
  onPc();
  assert.equal((await pull()).ok, true);

  // Сервер пропал и поднят заново из вчерашнего архива: трёх свежих записей на нём нет.
  const queueFile = path.join(SERVER, "queue.jsonl");
  const fresh = [ids.x, ids.z, ids.v];
  const kept = readFileSync(queueFile, "utf8").split("\n").filter((l) => l.trim() && !fresh.includes(JSON.parse(l).id));
  writeFileSync(queueFile, kept.join("\n") + "\n");

  net.mode = "down";
  const took = await withFlags(["yes", "server-stopped"], () => takeover({ now: T("2030-06-03", "14:00") }));
  assert.equal(took.code, 0, took.lines.join("\n"));
  assert.deepEqual((await runOnce({ now: T("2030-06-03", "14:30", 1) })).published, ["x-vyshla-bez-servera"]);
  assert.deepEqual((await runOnce({ now: T("2030-06-06", "11:00", 1) })).handed, ["z-paket-bez-servera"]);

  net.mode = "up";
  const done = await handback({ waitMs: 200 });
  assert.equal(done.code, 0, done.lines.join("\n"));
  const text = done.lines.join("\n");
  assert.match(text, /x-vyshla-bez-servera — НА СЕРВЕРЕ ЗАПИСИ НЕТ.*Публикация записана в журнал/);
  assert.match(text, /z-paket-bez-servera \(пакет на ручную выкладку\) — НА СЕРВЕРЕ ЗАПИСИ НЕТ.*Пакет на ручную выкладку записан в журнал/);
  // Запись, которая ждала выхода, вернуть может только человек: согласие пропало вместе с сервером.
  assert.match(text, /на сервере нет записей, которые есть на компьютере: 1/);
  assert.match(text, /v-zhdala-vyhoda/);
  assert.equal(existsSync(path.join(PC, "TAKEOVER.json")), false);

  await asServer(async () => {
    assert.equal(stopState().stopped, false);
    assert.equal(store.get(ids.x), null, "вышедшая запись в очередь не возвращается, одобренная тем более");
    const rows = ledger.rows().filter((r) => r.orphan);
    assert.deepEqual(rows.map((r) => `${r.name} · ${r.status}`).sort(), ["x-vyshla-bez-servera · published", "z-paket-bez-servera · handed"]);
    assert.match(rows.find((r) => r.status === "published").link, /x-vyshla-bez-servera/);
    // Повтор той же отметки строку не задваивает.
    const again = await execute("mark", { ref: ids.x, link: "https://x", takeover: true, entry: { channel: "threads", kind: "thread", name: "x-vyshla-bez-servera" } }, "оператор (дубль)");
    assert.equal(again.code, 0);
    assert.equal(ledger.rows().filter((r) => r.id === ids.x && r.orphan).length, 1);
    // Без сведений о записи команда по-прежнему отказывает по правилу: руками так не отмечают.
    assert.equal((await execute("mark", { ref: "нет-такой", link: "https://x" }, "оператор")).code, 1);
  });
});

test("по последней копии выпуск остановлен человеком: при молчащем сервере перехвата нет даже с подтверждением", async () => {
  await asServer(() => execute("pause", { reason: "ждём решения клиента" }, "оператор"));
  onPc();
  assert.equal((await pull()).ok, true);
  net.mode = "down";
  const out = await withFlags(["yes", "server-stopped"], () => takeover());
  assert.equal(out.code, 1);
  assert.match(out.lines.join("\n"), /по последней копии .* выпуск остановлен человеком/);
  assert.equal(existsSync(path.join(PC, "TAKEOVER.json")), false);
  net.mode = "up";
  await asServer(() => execute("resume", {}, "оператор"));
});
