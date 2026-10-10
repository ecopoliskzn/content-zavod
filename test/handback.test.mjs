// То, что нашла третья вычитка завода 10.10.2026: возврат расписания, сверка при перехвате
// и сервер, поднятый из архива. Каждый тест начинает с новой пары машин (fresh) и держит
// один найденный случай; что было не так, записано в docs/05-ГРАБЛИ.md.
import test from "node:test";
import assert from "node:assert/strict";
import {
  fresh, serverDir, pcDir, mirrorDir, onServer, onPc, asServer, asPc, net, sent, said, calls, plan,
  store, ledger, execute, runOnce, mirror, sw, approval, staff,
  withFlags, press, command, thread, approved, local, remote, T,
  existsSync, readFileSync, writeFileSync, path,
} from "./helpers/two-machines.mjs";

const takeoverFile = () => path.join(pcDir(), "TAKEOVER.json");
const where = () => calls.map((c) => `${c.name} · ${c.where}`);

test("оборванный возврат не снимает «стоп» человека, принятый с сервера", async () => {
  fresh();
  await asServer(async () => {
    await approved(thread("a-do-stopa", "2030-03-12", "19:00"));
    await approved(thread("b-posle-stopa", "2030-03-13", "14:30"));
  });
  onPc();
  assert.equal((await mirror.pull()).ok, true);
  assert.equal((await withFlags(["yes"], () => mirror.takeover({ now: T("2030-03-12", "14:30") }))).code, 0);
  assert.deepEqual((await runOnce({ now: T("2030-03-12", "19:00", 1) })).published, ["a-do-stopa"]);
  // Утверждающий останавливает выпуск, компьютер принимает остановку при сверке.
  await asServer(() => command("/stop_release"));
  assert.equal((await runOnce({ now: T("2030-03-12", "19:00", 6) })).stopped, true);

  // Возврат: сервер ответил на первый запрос и лёг на передаче.
  net.budget = 1;
  const broken = await mirror.handback({ waitMs: 200 });
  assert.equal(broken.code, 2);
  const mine = asPc(() => sw.stopState());
  assert.deepEqual([mine.human, mine.handback, mine.reason], [true, true, sw.ADOPTED_STOP], "у возврата своя отметка, слово человека цело");

  // Сервер недоступен. Повторный возврат говорит правду о выпуске на компьютере.
  net.budget = Infinity;
  net.mode = "down";
  const again = await mirror.handback({ waitMs: 200 });
  assert.equal(again.code, 2);
  assert.match(again.lines.join("\n"), /Выпуск на этом компьютере при этом стоит/);

  // Оператор отменяет возврат, как велит подсказка. Его отметка снята, «стоп» человека нет.
  const resumed = await execute("resume", { local: true }, "оператор");
  assert.equal(resumed.code, 0);
  assert.match(resumed.lines.join("\n"), /остаётся остановленным: его остановил человек на сервере/);
  assert.deepEqual(asPc(() => [sw.stopState().human, sw.stopState().handback]), [true, false]);
  calls.length = 0;
  assert.equal((await runOnce({ now: T("2030-03-13", "14:30", 1) })).stopped, true);
  assert.deepEqual(calls, [], "после «стоп» клиента с компьютера не вышло ничего");
  // Снять чужое слово оператор может только осознанно.
  assert.equal((await execute("resume", { local: true, force: true }, "оператор")).code, 0);
  assert.equal(asPc(() => sw.stopState().stopped), false);
});

test("запись, которую оператор посмотрел и вернул в расписание, сверка заново не придерживает", async () => {
  fresh();
  const ids = {};
  await asServer(async () => {
    ids.x = (await approved(thread("x-server-nachal", "2030-03-12", "19:00"))).id;
    // Вторая запись на сервере исчерпала попытки ещё до копии.
    ids.z = (await approved(thread("z-oshibka-na-servere", "2030-03-12", "14:30"))).id;
    await store.transition(ids.z, "running", { startedAt: new Date().toISOString(), attempts: 3 }, "выпуск");
    await store.transition(ids.z, "failed", { note: "площадка отказала" }, "выпуск");
  });
  onPc();
  assert.equal((await mirror.pull()).ok, true);
  // Сервер взял первую запись в работу и умер посреди отправки.
  await asServer(() => store.transition(ids.x, "running", { startedAt: new Date().toISOString(), attempts: 1 }, "выпуск"));
  net.mode = "down";
  const took = await withFlags(["yes", "server-stopped"], () => mirror.takeover({ now: T("2030-03-12", "19:00", 20) }));
  assert.equal(took.code, 0, took.lines.join("\n"));
  assert.deepEqual([local(ids.x).status, local(ids.x).takeoverHold], ["failed", true]);

  // Оператор посмотрел площадку: записей там нет. Возвращает обе в расписание.
  for (const name of ["x-server-nachal", "z-oshibka-na-servere"]) {
    assert.equal((await execute("move", { ref: name, channel: "threads", next: true, local: true }, "оператор")).code, 0);
  }
  assert.deepEqual([local(ids.x).status, local(ids.x).humanMoved, local(ids.z).status], ["approved", true, "approved"]);

  // Сервер вернулся: на нём первая запись «выходит», вторая «ошибка». Решение человека в силе.
  net.mode = "up";
  const order = [local(ids.x), local(ids.z)].sort((a, b) => T(a.date, a.time) - T(b.date, b.time));
  calls.length = 0;
  for (const e of order) {
    const run = await runOnce({ now: T(e.date, e.time, 1) });
    assert.deepEqual(run.published, [e.name], `в свой слот запись вышла: ${e.name}`);
  }
  assert.deepEqual(where().sort(), ["x-server-nachal · компьютер", "z-oshibka-na-servere · компьютер"]);
  // Возврат закрывает обе на сервере: второй раз они не выйдут.
  const done = await mirror.handback({ waitMs: 200 });
  assert.equal(done.code, 0, done.lines.join("\n"));
  assert.deepEqual([remote(ids.x).status, remote(ids.z).status], ["published", "published"]);
});

test("сервер жив и без отметки перехвата, а поставить её не удалось: компьютер проход пропускает", async () => {
  fresh();
  const ids = {};
  await asServer(async () => { ids.z = (await approved(thread("z-v-slot", "2030-03-12", "19:00"))).id; });
  onPc();
  assert.equal((await mirror.pull()).ok, true);
  net.mode = "down";
  assert.equal((await withFlags(["yes", "server-stopped"], () => mirror.takeover({ now: T("2030-03-12", "14:00") }))).code, 0);

  // Сервер включили. Он отвечает, но запрос «встань на паузу» до него не доходит.
  net.mode = "up";
  net.hook = (cmd) => (cmd === "pause" ? "drop-request" : undefined);
  const skipped = await runOnce({ now: T("2030-03-12", "19:00", 1) });
  assert.equal(skipped.stopped, true);
  assert.match(skipped.idle, /отметки перехвата на нём нет/);
  assert.deepEqual(calls, [], "компьютер не выпускает: сервер в эту минуту может выпускать сам");
  // Сервер и правда выпускает сам.
  assert.deepEqual((await asServer(() => runOnce({ now: T("2030-03-12", "19:00", 1) }))).published, ["z-v-slot"]);

  // Связь наладилась: отметка встала, вышедшее на сервере принято, с компьютера оно не выходит.
  net.hook = null;
  const next = await runOnce({ now: T("2030-03-12", "19:00", 6) });
  assert.deepEqual(next.published, []);
  assert.equal(local(ids.z).status, "published");
  assert.deepEqual(where(), ["z-v-slot · сервер"], "запись вышла один раз");
  assert.equal(await asServer(() => sw.stopState().takeover), true);
});

test("ответ на последний запрос возврата потерялся: компьютер не выпускает, пока не ясно, что делает сервер", async () => {
  fresh();
  const ids = {};
  await asServer(async () => {
    ids.a = (await approved(thread("a-segodnya", "2030-03-12", "19:00"))).id;
    ids.z = (await approved(thread("z-zavtra", "2030-03-13", "14:30"))).id;
  });
  onPc();
  assert.equal((await mirror.pull()).ok, true);
  assert.equal((await withFlags(["yes"], () => mirror.takeover({ now: T("2030-03-12", "14:30") }))).code, 0);
  assert.deepEqual((await runOnce({ now: T("2030-03-12", "19:00", 1) })).published, ["a-segodnya"]);

  // Сервер исполнил «включить выпуск», а ответ не дошёл.
  net.hook = (cmd, args) => (cmd === "resume" && args.handback ? "drop-response" : undefined);
  const lost = await mirror.handback({ waitMs: 200 });
  assert.equal(lost.code, 2);
  assert.match(lost.lines.join("\n"), /неизвестно, включил ли сервер выпуск/);
  assert.equal(await asServer(() => sw.stopState().stopped), false, "на самом деле сервер уже выпускает");
  assert.equal(JSON.parse(readFileSync(takeoverFile(), "utf8")).serverMayRun, true);

  // Связи с сервером нет. «Продолжить перехват» без подтверждения отвечает отказом.
  net.hook = null;
  net.mode = "down";
  const refused = await execute("resume", { local: true }, "оператор");
  assert.equal(refused.code, 1);
  assert.match(refused.lines.join("\n"), /--server-stopped/);
  calls.length = 0;
  const idle = await runOnce({ now: T("2030-03-13", "14:30", 1) });
  assert.equal(idle.stopped, true);
  assert.deepEqual(calls, []);
  // Сервер выпускает завтрашнюю запись сам, и только он.
  assert.deepEqual((await asServer(() => runOnce({ now: T("2030-03-13", "14:30", 1) }))).published, ["z-zavtra"]);

  // Связь вернулась: повтор возврата заканчивает дело и ничего не задваивает.
  net.mode = "up";
  const done = await mirror.handback({ waitMs: 200 });
  assert.equal(done.code, 0, done.lines.join("\n"));
  assert.equal(existsSync(takeoverFile()), false);
  assert.deepEqual(where(), ["z-zavtra · сервер"]);
  assert.equal(await asServer(() => ledger.rows().filter((r) => r.id === ids.a && r.status === "published").length), 1);
});

test("после потерянного ответа перехват продолжается только с подтверждением, что сервер остановлен", async () => {
  fresh();
  await asServer(async () => {
    await approved(thread("a-segodnya", "2030-03-12", "19:00"));
    await approved(thread("z-zavtra", "2030-03-13", "14:30"));
  });
  onPc();
  assert.equal((await mirror.pull()).ok, true);
  assert.equal((await withFlags(["yes"], () => mirror.takeover({ now: T("2030-03-12", "14:30") }))).code, 0);
  // До сервера последний запрос не дошёл вовсе, и сервер после этого лёг: отметка перехвата на нём цела.
  net.hook = (cmd, args) => (cmd === "resume" && args.handback ? "drop-request" : undefined);
  assert.equal((await mirror.handback({ waitMs: 200 })).code, 2);
  net.hook = null;
  net.mode = "down";
  assert.equal((await runOnce({ now: T("2030-03-12", "19:00", 1) })).stopped, true, "без подтверждения компьютер ждёт");
  // Оператор убедился, что сервер лежит, и подтверждает это.
  const go = await execute("resume", { local: true, "server-stopped": true }, "оператор");
  assert.equal(go.code, 0);
  assert.deepEqual((await runOnce({ now: T("2030-03-12", "19:00", 6) })).published, ["a-segodnya"]);
});

test("часть ветки вышла с компьютера, а сверка сняла запись: сервер о вышедшей части узнаёт", async () => {
  fresh();
  const posts = (name) => [`«${name}»: площадку в Казани сдали в срок.`, "Через год по ней пошли трещины.", "Причина нашлась в акте приёмки."];
  const ids = {};
  await asServer(async () => {
    ids.a = (await approved(thread("a-otzovut", "2030-03-12", "19:00", posts("a-otzovut")))).id;
    ids.b = (await approved(thread("b-ispravyat", "2030-03-13", "19:00", posts("b-ispravyat")))).id;
  });
  onPc();
  assert.equal((await mirror.pull()).ok, true);
  assert.equal((await withFlags(["yes"], () => mirror.takeover({ now: T("2030-03-12", "14:30") }))).code, 0);
  // Обе ветки рвутся после первой реплики: повтор через пять минут.
  plan["a-otzovut"] = () => ({ ok: false, error: "сеть оборвалась", retry: true, done: ["a1"], link: "https://www.threads.net/@eco/post/a1" });
  plan["b-ispravyat"] = () => ({ ok: false, error: "сеть оборвалась", retry: true, done: ["b1"], link: "https://www.threads.net/@eco/post/b1" });

  // А: между попытками утверждающий отозвал согласие.
  assert.deepEqual((await runOnce({ now: T("2030-03-12", "19:00", 1) })).retry, ["a-otzovut"]);
  await asServer(() => press(`q:undo:${ids.a}`));
  await runOnce({ now: T("2030-03-12", "19:00", 6) });
  assert.deepEqual([local(ids.a).status, local(ids.a).done], ["cancelled", ["a1"]]);

  // Б: между попытками запись исправили и одобрили заново.
  assert.deepEqual((await runOnce({ now: T("2030-03-13", "19:00", 1) })).retry, ["b-ispravyat"]);
  await asServer(async () => {
    await execute("add", { entries: [{ ...thread("b-ispravyat", "2030-03-13", "19:00"), posts: ["«b-ispravyat»: площадку в Казани сдали в срок, а через год пошли трещины.", "Через год по ней пошли трещины.", "Причина нашлась в акте приёмки."] }] }, "S1");
    await approval.submit(ids.b, "S1");
    await press(`q:ok:${ids.b}`);
  });
  await runOnce({ now: T("2030-03-13", "19:00", 6) });
  assert.equal(local(ids.b).status, "cancelled");

  net.log.length = 0;
  sent.length = 0;
  const done = await mirror.handback({ waitMs: 200 });
  assert.equal(done.code, 0, done.lines.join("\n"));
  assert.equal(net.log.filter((c) => c.startsWith("mark(takeover)(partial)")).length, 2, "о начатых ветках серверу сказано");
  const text = done.lines.join("\n");
  assert.match(text, /a-otzovut \(начата и не закончена, вышло частей: 1\) — БЕЗ СОГЛАСИЯ/);
  assert.match(text, /b-ispravyat \(начата и не закончена, вышло частей: 1\) — ПРЕЖНИЙ ТЕКСТ/);
  // Человек клиента узнаёт о вышедшем начале обеих веток.
  assert.match(said(), /a-otzovut» начала выходить во время аварии сервера \(вышло частей: 1\)/);
  assert.match(said(), /b-ispravyat» начала выходить во время аварии сервера прежним текстом/);
  // Обе записи закрыты: после нового «да» ветка с первой реплики второй раз не выйдет.
  assert.deepEqual([remote(ids.a).status, remote(ids.b).status], ["cancelled", "cancelled"]);
  delete plan["a-otzovut"];
  delete plan["b-ispravyat"];
  await asServer(() => press(`q:ok:${ids.a}`));
  calls.length = 0;
  await asServer(() => runOnce({ now: T("2030-03-13", "19:00", 30) }));
  assert.deepEqual(calls, []);
});

test("возврат на сервер из архива: вышедшее до аварии второй раз не выходит, архиву компьютер не верит", async () => {
  fresh();
  const ids = {};
  const fixed = ["«t-ispravlena»: площадку в Казани сдали в срок, а через год пошли трещины.", "Причина нашлась в акте: толщину никто не мерил."];
  await asServer(async () => {
    ids.s = (await approved(thread("s-vyshla-na-servere", "2030-03-12", "14:30"))).id;
    ids.t = (await approved(thread("t-ispravlena", "2030-03-13", "14:30"))).id;
    // Эта запись в ночном архиве ещё ждёт согласования.
    const { entry } = await store.put(thread("q-odobrena-posle-arhiva", "2030-03-12", "19:00"), "S1");
    await approval.submit(entry.id, "S1");
    ids.q = entry.id;
  });
  const nightly = { queue: readFileSync(path.join(serverDir(), "queue.jsonl"), "utf8"), ledger: existsSync(path.join(serverDir(), "ledger.jsonl")) ? readFileSync(path.join(serverDir(), "ledger.jsonl"), "utf8") : "" };
  // День после архива: одна запись вышла с сервера, одну одобрили, одну исправили и одобрили заново.
  await asServer(async () => {
    assert.deepEqual((await runOnce({ now: T("2030-03-12", "14:30", 1) })).published, ["s-vyshla-na-servere"]);
    await press(`q:ok:${ids.q}`);
    await execute("add", { entries: [{ ...thread("t-ispravlena", "2030-03-13", "14:30"), posts: fixed }] }, "S1");
    await approval.submit(ids.t, "S1");
    await press(`q:ok:${ids.t}`);
  });
  onPc();
  assert.equal((await mirror.pull()).ok, true);
  net.mode = "down";
  assert.equal((await withFlags(["yes", "server-stopped"], () => mirror.takeover({ now: T("2030-03-12", "15:30") }))).code, 0);

  // Сервер сгорел и поднят из ночного архива. В архиве лежит отметка, выпуск встал на удержание.
  writeFileSync(path.join(serverDir(), "queue.jsonl"), nightly.queue, "utf8");
  writeFileSync(path.join(serverDir(), "ledger.jsonl"), nightly.ledger, "utf8");
  writeFileSync(path.join(serverDir(), "RESTORED"), JSON.stringify({ archived: "2030-03-12T00:30:00Z" }));
  writeFileSync(path.join(serverDir(), "HOLD"), JSON.stringify({ at: new Date().toISOString(), silentMin: 750 }));
  assert.deepEqual([remote(ids.s).status, remote(ids.q).status], ["approved", "review"]);
  net.mode = "up";

  /* Сверка с таким сервером. Его «ждёт согласования» и его прежний текст ничего не значат:
     копия новее архива. Компьютер ставит отметку перехвата и своих записей не трогает. */
  await runOnce({ now: T("2030-03-12", "16:00") });
  assert.equal(await asServer(() => sw.stopState().takeover), true);
  assert.deepEqual([local(ids.q).status, local(ids.t).status], ["approved", "approved"], "архив не отменил согласие и не снял исправленный текст");
  calls.length = 0;
  assert.deepEqual((await runOnce({ now: T("2030-03-12", "19:00", 1) })).published, ["q-odobrena-posle-arhiva"]);
  assert.deepEqual((await runOnce({ now: T("2030-03-13", "14:30", 1) })).published, ["t-ispravlena"]);
  assert.equal(calls.find((c) => c.name === "t-ispravlena").first, fixed[0], "вышел исправленный текст из копии");

  sent.length = 0;
  const done = await mirror.handback({ waitMs: 200 });
  assert.equal(done.code, 0, done.lines.join("\n"));
  const text = done.lines.join("\n");
  assert.match(text, /сервер старше копии расписания/);
  assert.match(text, /по копии расписания отмечены вышедшими: s-vyshla-na-servere/);
  // Ложной тревоги нет: согласие было, просто архив о нём не знал.
  assert.doesNotMatch(text, /БЕЗ СОГЛАСИЯ|ПРЕЖНИЙ ТЕКСТ/);
  assert.doesNotMatch(said(), /без согласия|хотя на сервере она была|прежним текстом/);
  await asServer(async () => {
    assert.deepEqual([store.get(ids.s).status, store.get(ids.q).status, store.get(ids.t).status], ["published", "published", "published"]);
    for (const id of [ids.s, ids.q, ids.t]) assert.equal(ledger.rows().filter((r) => r.id === id && r.status === "published").length, 1);
    assert.deepEqual([sw.stopState().stopped, sw.isRestored(), sw.isHeld()], [false, false, false]);
    calls.length = 0;
    const run = await runOnce({ now: T("2030-03-13", "14:30", 10) });
    assert.deepEqual(run.published, []);
    assert.deepEqual(calls, [], "ничего из вышедшего второй раз не вышло");
  });
});

test("сервер из архива без перехвата: выпуск стоит до сверки с копией, сверка только закрывает и придерживает", async () => {
  fresh();
  const ids = {};
  const make = (name, date, time, posts) => approved(thread(name, date, time, posts));
  await asServer(async () => {
    ids.p = (await make("p-vyjdet", "2030-03-12", "14:30")).id;
    ids.c = (await make("c-snimut", "2030-03-13", "14:30")).id;
    ids.w = (await make("w-otzovut", "2030-03-13", "19:00")).id;
    ids.e = (await make("e-ispravyat", "2030-03-14", "14:30")).id;
    ids.r = (await make("r-nachnut", "2030-03-12", "19:00", ["«r-nachnut»: площадку в Казани сдали в срок.", "Через год по ней пошли трещины.", "Причина нашлась в акте приёмки."])).id;
    ids.k = (await make("k-bez-peremen", "2030-03-15", "14:30")).id;
    ids.m = (await make("m-perestavyat", "2030-03-15", "19:00")).id;
  });
  const nightly = { queue: readFileSync(path.join(serverDir(), "queue.jsonl"), "utf8"), ledger: existsSync(path.join(serverDir(), "ledger.jsonl")) ? readFileSync(path.join(serverDir(), "ledger.jsonl"), "utf8") : "" };

  // День после архива: одна запись вышла, одну сняли, одной отозвали согласие, одну исправили,
  // одну сервер начал и не закончил, одну поставили и одобрили заново.
  await asServer(async () => {
    assert.deepEqual((await runOnce({ now: T("2030-03-12", "14:30", 1) })).published, ["p-vyjdet"]);
    await press(`q:no:${ids.c}`);
    await press(`q:undo:${ids.w}`);
    await execute("add", { entries: [{ ...thread("e-ispravyat", "2030-03-14", "14:30"), posts: ["«e-ispravyat»: площадку в Казани сдали в срок, а через год пошли трещины.", "Причина нашлась в акте: толщину никто не мерил."] }] }, "S1");
    await approval.submit(ids.e, "S1");
    await press(`q:ok:${ids.e}`);
    await store.transition(ids.r, "running", { startedAt: new Date().toISOString(), attempts: 1 }, "выпуск");
    await store.patch(ids.r, { done: ["r1"], result: { link: "https://www.threads.net/@eco/post/r1" } }, "выпуск");
    ids.n = (await make("n-novaya", "2030-03-16", "14:30")).id;
    // Ещё одну запись утверждающий попросил отложить на неделю.
    assert.equal((await execute("move", { ref: ids.m, date: "2030-03-22", time: "19:00" }, "оператор")).code, 0);
  });
  onPc();
  assert.equal((await mirror.pull()).ok, true);
  const copy = readFileSync(path.join(mirrorDir(), "queue.json"), "utf8");

  // Сервер пропал и поднят из ночного архива. Скрипт копии положил в архив отметку RESTORED.
  writeFileSync(path.join(serverDir(), "queue.jsonl"), nightly.queue, "utf8");
  writeFileSync(path.join(serverDir(), "ledger.jsonl"), nightly.ledger, "utf8");
  writeFileSync(path.join(serverDir(), "RESTORED"), JSON.stringify({ archived: "2030-03-12T00:30:00Z" }));
  writeFileSync(path.join(serverDir(), "HOLD"), JSON.stringify({ at: new Date().toISOString(), silentMin: 600 }));

  // Выпуск стоит, кнопка «Продолжить выпуск» не действует.
  sent.length = 0;
  calls.length = 0;
  await asServer(async () => {
    const run = await runOnce({ now: T("2030-03-12", "19:00", 5) });
    assert.equal(run.restored, true);
    await staff.handleCallback({ id: "cb", data: "r:go", from: { id: 42, first_name: "Анна" } });
    assert.equal(sw.isHeld(), true, "кнопка удержание не сняла");
  });
  assert.match(said(), /Сервер восстановлен из архива/);
  assert.match(sent.find((s) => s.method === "answerCallbackQuery").body.text, /сначала оператор сверяет его с копией/);
  assert.deepEqual(calls, []);

  // Копию на компьютере снимок из архива не затирает.
  const stale = await mirror.pull();
  assert.deepEqual([stale.ok, stale.rolledBack], [false, true]);
  assert.match(stale.error, /старше копии/);
  assert.equal(readFileSync(path.join(mirrorDir(), "queue.json"), "utf8"), copy);

  const done = await mirror.reconcile();
  assert.equal(done.code, 0, done.lines.join("\n"));
  const text = done.lines.join("\n");
  assert.match(text, /отмечены вышедшими по копии: p-vyjdet/);
  assert.match(text, /сняты по копии: c-snimut/);
  assert.match(text, /согласие снято, нужно новое «да»: .*w-otzovut/);
  assert.match(text, /согласие снято, нужно новое «да»: .*e-ispravyat/);
  assert.match(text, /перенесено сделанное \(сервер продолжит со сверкой\): r-nachnut/);
  assert.match(text, /на сервере нет записей, которые есть в копии: 1/);
  assert.match(text, /переставлены на слот из копии: m-perestavyat/);
  assert.match(text, /n-novaya/);

  await asServer(async () => {
    assert.deepEqual(["p", "c", "w", "e", "r", "k"].map((k) => store.get(ids[k]).status), ["published", "cancelled", "review", "review", "approved", "approved"]);
    assert.deepEqual([store.get(ids.m).status, store.get(ids.m).date], ["approved", "2030-03-22"], "отложенная запись не выйдет в прежний слот из архива");
    assert.equal(store.get(ids.n), null, "согласие из копии не восстанавливается: записи, которой нет в архиве, сверка не создаёт");
    assert.deepEqual([store.get(ids.r).done, store.get(ids.r).attempts], [["r1"], 1]);
    assert.equal(ledger.rows().filter((r) => r.id === ids.p && r.status === "published").length, 1);
    assert.deepEqual([sw.isRestored(), sw.isHeld()], [false, false]);
    // Дальше сервер идёт по расписанию: начатая ветка продолжается с места обрыва и со сверкой.
    calls.length = 0;
    assert.deepEqual((await runOnce({ now: T("2030-03-12", "19:00", 10) })).published, ["r-nachnut"]);
    assert.deepEqual(calls.map((c) => [c.name, c.done, c.verify]), [["r-nachnut", ["r1"], true]]);
    // Снятая, отозванная и исправленная не выходят; нетронутая выходит в свой слот.
    calls.length = 0;
    await runOnce({ now: T("2030-03-13", "14:30", 1) });
    await runOnce({ now: T("2030-03-14", "14:30", 1) });
    assert.deepEqual(calls, []);
    assert.deepEqual((await runOnce({ now: T("2030-03-15", "14:30", 1) })).published, ["k-bez-peremen"]);
  });
  assert.match(said(), /Сервер сверен с копией расписания/);

  // Повтор сверки ничего не меняет, а свежая копия снимается обычным порядком.
  const again = await mirror.reconcile();
  assert.equal(again.code, 0);
  assert.equal(await asServer(() => ledger.rows().filter((r) => r.id === ids.p && r.status === "published").length), 1);
  assert.equal((await mirror.pull()).ok, true);
});

test("сервер откатили снимком диска: сторож видит расписание старше копии и останавливает выпуск", async () => {
  fresh();
  const ids = {};
  await asServer(async () => { ids.s = (await approved(thread("s-vyshla-do-otkata", "2030-03-12", "14:30"))).id; });
  const snapshot = { queue: readFileSync(path.join(serverDir(), "queue.jsonl"), "utf8") };
  assert.deepEqual((await asServer(() => runOnce({ now: T("2030-03-12", "14:30", 1) }))).published, ["s-vyshla-do-otkata"]);
  const ledgerAfter = readFileSync(path.join(serverDir(), "ledger.jsonl"), "utf8");
  onPc();
  assert.equal((await mirror.pull()).ok, true);

  // Хостинг вернул диск к снимку: отметки из архива нет, расписание просто стало старше.
  writeFileSync(path.join(serverDir(), "queue.jsonl"), snapshot.queue, "utf8");
  writeFileSync(path.join(serverDir(), "ledger.jsonl"), "", "utf8");
  assert.equal(await asServer(() => sw.isRestored()), false);

  const stale = await mirror.pull({ toleranceMs: 0 });
  assert.equal(stale.rolledBack, true);
  sent.length = 0;
  await mirror.rolledBack();
  assert.match(said(), /Сервер отдал расписание старше, чем копия/);
  assert.equal(await asServer(() => sw.isRestored()), true, "выпуск на сервере остановлен до сверки");
  calls.length = 0;
  assert.equal((await asServer(() => runOnce({ now: T("2030-03-12", "14:30", 10) }))).restored, true);
  assert.deepEqual(calls, []);

  assert.equal((await mirror.reconcile()).code, 0);
  assert.equal(remote(ids.s).status, "published");
  assert.equal(await asServer(() => sw.isRestored()), false);
  assert.ok(ledgerAfter.includes(ids.s));
});

test("«стоп», пришедший посреди прохода, останавливает проход на следующей записи", async () => {
  fresh();
  onServer();
  const a = await approved(thread("a-vetka", "2030-03-12", "19:00"));
  const { entry: b } = await store.put({ channel: "vk", kind: "post", name: "b-post-vk", material: "blog:primer", date: "2030-03-12", time: "19:00", text: "Площадку в Казани приняли после дождя, и через год покрытие пошло пузырями." }, "S1");
  await approval.submit(b.id, "S1");
  await press(`q:ok:${b.id}`);
  assert.deepEqual([a.status, store.get(b.id).status], ["approved", "approved"]);
  // Пока площадка принимает ветку, утверждающий отправляет /stop_release.
  plan["a-vetka"] = async () => { sent.length = 0; await command("/stop_release"); return { ok: true, id: "id-a", link: "https://www.threads.net/@eco/post/a", done: ["id-a"] }; };
  const run = await runOnce({ now: T("2030-03-12", "19:00", 1) });
  assert.deepEqual(run.published, ["a-vetka"]);
  assert.equal(run.stopped, true);
  assert.deepEqual(calls.map((c) => c.name), ["a-vetka"], "вторую запись проход уже не взял");
  assert.equal(store.get(b.id).status, "approved");
  // Бот не обещает «ничего»: идущая отправка довыйдет.
  assert.match(sent.find((s) => /Выпуск остановлен/.test(s.body.text || "")).body.text, /отправка которой уже началась, довыйдет/);
});

test("перехват: сервер вернулся старше копии и без отметки из архива — компьютер его статусам не верит", async () => {
  fresh();
  const ids = {};
  await asServer(async () => { ids.q = (await approved(thread("q-odobrena", "2030-03-12", "19:00"))).id; });
  onPc();
  assert.equal((await mirror.pull()).ok, true);
  net.mode = "down";
  assert.equal((await withFlags(["yes", "server-stopped"], () => mirror.takeover({ now: T("2030-03-12", "14:00") }))).code, 0);
  // Хостинг вернул диск сервера к снимку, где запись ещё ждала «да». Отметки из архива на нём нет.
  await asServer(() => store.transition(ids.q, "review", { approval: undefined }, "снимок диска"));
  // Копия свежее сервера на десять минут: в жизни разрыв измеряется часами.
  const takeoverFilePath = takeoverFile();
  const taken = JSON.parse(readFileSync(takeoverFilePath, "utf8"));
  writeFileSync(takeoverFilePath, JSON.stringify({ ...taken, copyFresh: Date.now() + 10 * 60_000 }));
  net.mode = "up";

  const run = await runOnce({ now: T("2030-03-12", "19:00", 1) });
  assert.equal(await asServer(() => sw.isRestored()), true, "сервер помечен: до сверки с копией он не выпускает");
  assert.deepEqual(run.published, ["q-odobrena"], "одобренная по копии запись вышла, статус из снимка её не снял");
  const done = await mirror.handback({ waitMs: 200 });
  assert.equal(done.code, 0, done.lines.join("\n"));
  assert.doesNotMatch(done.lines.join("\n"), /БЕЗ СОГЛАСИЯ/);
  assert.equal(remote(ids.q).status, "published");
});
