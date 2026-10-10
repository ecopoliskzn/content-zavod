import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReportBuilder, cardLink } from "../src/report.mjs";

function jsonl(lines) {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function dir() {
  return mkdtempSync(join(tmpdir(), "liga-bot-report-"));
}

function iso(now, hoursAgo) {
  return new Date(now - hoursAgo * 3600_000).toISOString();
}

test("требует storageDir", () => {
  assert.throws(() => createReportBuilder({}));
});

test("пустой каталог — воронка нулями, списки «пока пусто»", async () => {
  const d = dir();
  const report = createReportBuilder({ storageDir: d });
  const { text, ownerSummary, counts } = await report.build(new Date());
  assert.match(text, /Пришли 0 → согласились 0 → статья 0 → начали проверку 0 → прошли 0 → заявки 0/);
  assert.match(text, /Ждут ответа<\/b>\nпока пусто/);
  assert.match(text, /Что болит чаще всего<\/b>\nпока пусто/);
  assert.equal(counts.waiting, 0);
  assert.match(ownerSummary, /Ждут ответа: 0/);
  rmSync(d, { recursive: true, force: true });
});

test("cardLink: t.me/c/<chatId без -100>/<messageId>", () => {
  assert.equal(cardLink("-1001234567890", 42), "https://t.me/c/1234567890/42");
  assert.equal(cardLink("-100999", 7), "https://t.me/c/999/7");
  assert.equal(cardLink(undefined, 7), undefined);
  assert.equal(cardLink("-1001234567890", undefined), undefined);
});

test("считает воронку по funnel.* и заявки за окно, тестовый аккаунт исключён", async () => {
  const d = dir();
  const now = Date.now();
  writeFileSync(
    join(d, "tg-subscribers.jsonl"),
    jsonl([
      {
        id: "1",
        profile: { firstName: "Оля" },
        entryOrigin: "instagram",
        entryKey: "rol-hr",
        funnel: {
          startedAt: iso(now, 5),
          consentAt: iso(now, 4.9),
          materialAt: iso(now, 4.8),
          diagStartedAt: iso(now, 2),
          diagDoneAt: iso(now, 1.9),
          leadAt: iso(now, 1),
        },
        lead: { status: "new" },
      },
      {
        // тестовый аккаунт — не должен попасть ни в одну цифру
        id: "999",
        isTest: true,
        entryOrigin: "telegram",
        funnel: { startedAt: iso(now, 1), consentAt: iso(now, 1), materialAt: iso(now, 1), diagStartedAt: iso(now, 1), diagDoneAt: iso(now, 1), leadAt: iso(now, 1) },
      },
      {
        // за окном (30 часов назад при окне 24ч)
        id: "2",
        entryOrigin: "site",
        funnel: { startedAt: iso(now, 30) },
      },
    ]),
  );

  const report = createReportBuilder({ storageDir: d, excludeIds: [] });
  const { counts, text } = await report.build(new Date(now));
  assert.equal(counts.funnel.started, 1);
  assert.equal(counts.funnel.consent, 1);
  assert.equal(counts.funnel.material, 1);
  assert.equal(counts.funnel.diagStarted, 1);
  assert.equal(counts.funnel.diagDone, 1);
  assert.equal(counts.funnel.lead, 1);
  assert.doesNotMatch(text, /Тест/, "тестовый аккаунт не должен упоминаться в тексте");
  rmSync(d, { recursive: true, force: true });
});

test("отменённая заявка (lead.status cancelled) не считается в воронке", async () => {
  const d = dir();
  const now = Date.now();
  writeFileSync(
    join(d, "tg-subscribers.jsonl"),
    jsonl([{ id: "1", funnel: { startedAt: iso(now, 2), leadAt: iso(now, 1) }, lead: { status: "cancelled" } }]),
  );
  const report = createReportBuilder({ storageDir: d });
  const { counts } = await report.build(new Date(now));
  assert.equal(counts.funnel.lead, 0);
  rmSync(d, { recursive: true, force: true });
});

test("разбивка по источникам и топ ключей", async () => {
  const d = dir();
  const now = Date.now();
  writeFileSync(
    join(d, "tg-subscribers.jsonl"),
    jsonl([
      { id: "1", entryOrigin: "instagram", entryKey: "rol-hr", funnel: { startedAt: iso(now, 1) } },
      { id: "2", entryOrigin: "instagram", entryKey: "rol-hr", funnel: { startedAt: iso(now, 1) } },
      { id: "3", entryOrigin: "site", entryKey: "kalkulyator", funnel: { startedAt: iso(now, 1) } },
      { id: "4", funnel: { startedAt: iso(now, 1) } }, // без entryOrigin → считается Telegram
    ]),
  );
  const report = createReportBuilder({ storageDir: d });
  const { counts, text } = await report.build(new Date(now));
  assert.equal(counts.bySource.instagram, 2);
  assert.equal(counts.bySource.site, 1);
  assert.equal(counts.bySource.telegram, 1);
  assert.match(text, /Instagram 2 · Threads 0 · Сайт 1 · Telegram 1/);
  assert.deepEqual(counts.topKeys[0], { key: "rol-hr", count: 2 });
  assert.match(text, /Ключи: rol-hr 2, kalkulyator 1/);
  rmSync(d, { recursive: true, force: true });
});

test("Ключи — человеческие подписи из config.keyLabels (word из materials.json), без подписи — сырой ключ", async () => {
  const d = dir();
  const now = Date.now();
  writeFileSync(
    join(d, "tg-subscribers.jsonl"),
    jsonl([
      { id: "1", entryOrigin: "instagram", entryKey: "rol-hr", funnel: { startedAt: iso(now, 1) } },
      { id: "2", entryOrigin: "instagram", entryKey: "rol-hr", funnel: { startedAt: iso(now, 1) } },
      { id: "3", entryOrigin: "site", entryKey: "bez-slova", funnel: { startedAt: iso(now, 1) } },
    ]),
  );
  // @zavod/bot контент приложения не читает — карту key→word передаёт вызывающий скрипт
  // (apps/bot-instance/scripts/report.mjs::materialKeyLabels из content/materials.json).
  const report = createReportBuilder({ storageDir: d, keyLabels: { "rol-hr": "РОЛЬ HR" } });
  const { text } = await report.build(new Date(now));
  assert.match(text, /Ключи: РОЛЬ HR 2, bez-slova 1/);
  rmSync(d, { recursive: true, force: true });
});

test("«ждут ответа»: исключает взятых в работу, отклонённых и тестовых; заявки выше диагностик, дольше ждущие — выше", async () => {
  const d = dir();
  const now = Date.now();
  writeFileSync(
    join(d, "tg-subscribers.jsonl"),
    jsonl([
      {
        id: "10",
        profile: { firstName: "Ирина", lastName: "Петрова" },
        funnel: { leadAt: iso(now, 3) },
        salesCard: { messageId: 55, status: "lead" },
      },
      {
        // тоже заявка, но ждёт дольше — должна быть выше Ирины внутри группы «заявки»
        id: "14",
        profile: { firstName: "Настя" },
        funnel: { leadAt: iso(now, 6) },
        salesCard: { messageId: 60, status: "lead" },
      },
      {
        // диагностика, ждёт дольше обеих заявок — но группа «заявки» всё равно выше
        id: "11",
        profile: { firstName: "Олег" },
        funnel: { diagDoneAt: iso(now, 5) },
        salesCard: { messageId: 56, status: "diag" },
      },
      {
        // взят в работу — не должен попасть в список
        id: "12",
        profile: { firstName: "Взятый" },
        funnel: { leadAt: iso(now, 2) },
        salesCard: { messageId: 57, status: "lead", takenBy: "demo" },
      },
      {
        // отклонён («не целевой») — уже решённый вопрос, не «ждёт ответа»
        id: "13",
        profile: { firstName: "Отклонённый" },
        funnel: { diagDoneAt: iso(now, 2) },
        salesCard: { messageId: 58, status: "diag", rejectedBy: "demo" },
      },
      {
        // тестовый — не должен попасть, даже с открытой карточкой
        id: "999",
        isTest: true,
        profile: { firstName: "Тест" },
        funnel: { leadAt: iso(now, 1) },
        salesCard: { messageId: 59, status: "lead" },
      },
    ]),
  );

  const report = createReportBuilder({ storageDir: d, notifyChatId: "-1001234567890" });
  const { counts, text } = await report.build(new Date(now));
  assert.equal(counts.waiting, 3);
  const ids = counts.waitingList.map((w) => w.id).sort();
  assert.deepEqual(ids, ["10", "11", "14"]);
  assert.doesNotMatch(text, /Взятый/);
  assert.doesNotMatch(text, /Отклонённый/);
  assert.doesNotMatch(text, /Тест/);

  // Имя — HTML-ссылкой на карточку (не голый URL), разделитель «·», без тире.
  assert.match(text, /🔥 <a href="https:\/\/t\.me\/c\/1234567890\/60">Настя<\/a> · 6 ч/);
  assert.match(text, /🔥 <a href="https:\/\/t\.me\/c\/1234567890\/55">Ирина Петрова<\/a> · 3 ч/);
  assert.match(text, /🟡 <a href="https:\/\/t\.me\/c\/1234567890\/56">Олег<\/a> · 5 ч/);

  const iНастя = text.indexOf("Настя");
  const iИрина = text.indexOf("Ирина");
  const iОлег = text.indexOf("Олег");
  assert.ok(iНастя < iИрина, "внутри группы «заявки» дольше ждущая (Настя, 6ч) — выше Ирины (3ч)");
  assert.ok(iИрина < iОлег, "все заявки (🔥) выше диагностик (🟡), даже если диагностика ждёт дольше (Олег, 5ч)");
  rmSync(d, { recursive: true, force: true });
});

test("«ждут ответа» ограничен 10 записями, дальше — «и ещё N»", async () => {
  const d = dir();
  const now = Date.now();
  const subs = [];
  for (let i = 0; i < 13; i++) {
    subs.push({ id: String(i), profile: { firstName: `Человек${i}` }, funnel: { leadAt: iso(now, i + 1) }, salesCard: { messageId: 100 + i, status: "lead" } });
  }
  writeFileSync(join(d, "tg-subscribers.jsonl"), jsonl(subs));
  const report = createReportBuilder({ storageDir: d, notifyChatId: "-100111" });
  const { text, counts } = await report.build(new Date(now));
  assert.equal(counts.waiting, 13);
  assert.match(text, /и ещё 3/);
  rmSync(d, { recursive: true, force: true });
});

test("топ-3 «болит» за 7 дней, в пределах суточного окна отчёта не ограничен", async () => {
  const d = dir();
  const now = Date.now();
  writeFileSync(
    join(d, "tg-subscribers.jsonl"),
    jsonl([
      { id: "1", diag: { итог: { weak: ["нет времени и рук", "саботируют молча"] } }, funnel: { diagDoneAt: iso(now, 40) } },
      { id: "2", diag: { итог: { weak: ["нет времени и рук"] } }, funnel: { diagDoneAt: iso(now, 60) } },
      { id: "3", diag: { итог: { weak: ["нет времени и рук", "HR подключают после"] } }, funnel: { diagDoneAt: iso(now, 100) } },
      { id: "4", diag: { итог: { weak: ["слишком старое, за пределами 7 дней"] } }, funnel: { diagDoneAt: iso(now, 8 * 24) } },
    ]),
  );
  const report = createReportBuilder({ storageDir: d, hours: 24 });
  const { text, counts } = await report.build(new Date(now));
  assert.equal(counts.weakTop[0].text, "нет времени и рук");
  assert.equal(counts.weakTop[0].count, 3);
  assert.match(text, /1\. нет времени и рук · 3/);
  assert.doesNotMatch(text, /слишком старое/);
  rmSync(d, { recursive: true, force: true });
});

test("сводка владельцу не содержит ПДн: ни @, ни tg:\\/\\/, ни телефонных цифр, ни имён", async () => {
  const d = dir();
  const now = Date.now();
  writeFileSync(
    join(d, "tg-subscribers.jsonl"),
    jsonl([
      {
        id: "1",
        profile: { firstName: "Пётр", lastName: "Петров", username: "petr_petrov" },
        entryOrigin: "instagram",
        entryKey: "rol-hr",
        funnel: { startedAt: iso(now, 1), leadAt: iso(now, 1) },
        lead: { contact: "@petr_petrov", phone: "+79991234567" },
        salesCard: { messageId: 5, status: "lead" },
      },
    ]),
  );
  const report = createReportBuilder({ storageDir: d, notifyChatId: "-1001234567890" });
  const { ownerSummary } = await report.build(new Date(now));
  assert.doesNotMatch(ownerSummary, /@/);
  assert.doesNotMatch(ownerSummary, /tg:\/\//);
  assert.doesNotMatch(ownerSummary, /\d{5,}/, "нет длинных цифровых последовательностей (телефон/chat id/message id)");
  assert.doesNotMatch(ownerSummary, /Пётр|Петров/);
  assert.doesNotMatch(ownerSummary, /t\.me/);
  rmSync(d, { recursive: true, force: true });
});

test("терпим к старым записям без funnel/salesCard/isTest — не падает, считает по событиям и лидам", async () => {
  const d = dir();
  const now = Date.now();
  // Старая запись подписчика — без funnel, без salesCard, как писал report v1.
  writeFileSync(
    join(d, "tg-subscribers.jsonl"),
    jsonl([{ id: "1", name: "Игорь Старый", subscribedAt: iso(now, 2), consent: "accepted" }]),
  );
  writeFileSync(
    join(d, "tg-events.jsonl"),
    jsonl([
      { at: iso(now, 1), event: { message: { text: "привет", chat: { id: 1, type: "private" }, from: { id: 1, first_name: "Игорь" } } } },
      { at: iso(now, 1), event: { message: { text: "тест", chat: { id: 999, type: "private" }, from: { id: 999, first_name: "Тестовый" } } } },
    ]),
  );
  writeFileSync(join(d, "leads.jsonl"), jsonl([{ createdAt: iso(now, 1), name: "Игорь Старый", contact: "@igor", telegramId: "1" }]));

  const report = createReportBuilder({ storageDir: d, excludeIds: ["999"] });
  const { counts } = await report.build(new Date(now));
  assert.equal(counts.funnel.started, 1, "старый подписчик учтён как «пришли» через subscribedAt/события");
  assert.equal(counts.funnel.lead, 1, "старый лид учтён через leads.jsonl");
  rmSync(d, { recursive: true, force: true });
});

test("hours сужает окно воронки", async () => {
  const d = dir();
  const now = Date.now();
  writeFileSync(join(d, "tg-subscribers.jsonl"), jsonl([{ id: "1", funnel: { startedAt: iso(now, 5) } }]));
  const report = createReportBuilder({ storageDir: d, hours: 3 });
  const { counts, text } = await report.build(new Date(now));
  assert.equal(counts.funnel.started, 0, "событие 5 часов назад не входит в 3-часовое окно");
  assert.match(text, /Воронка за 3 ч/);
  rmSync(d, { recursive: true, force: true });
});

test("экранирует HTML в имени и «болит», чтобы не ломать parse_mode HTML", async () => {
  const d = dir();
  const now = Date.now();
  writeFileSync(
    join(d, "tg-subscribers.jsonl"),
    jsonl([
      {
        id: "1",
        profile: { firstName: "<b>Имя</b>" },
        funnel: { leadAt: iso(now, 1), diagDoneAt: iso(now, 1) },
        salesCard: { messageId: 1, status: "lead" },
        diag: { итог: { weak: ["<script>боль</script>"] } },
      },
    ]),
  );
  const report = createReportBuilder({ storageDir: d });
  const { text } = await report.build(new Date(now));
  assert.doesNotMatch(text, /<script>/);
  assert.doesNotMatch(text, /<b>Имя<\/b>/);
  assert.match(text, /&lt;b&gt;Имя&lt;\/b&gt;/);
  rmSync(d, { recursive: true, force: true });
});

test("в пользовательском тексте нет длинных тире (стиль проекта — CLAUDE.md, «Копирайт/тон»)", async () => {
  const d = dir();
  const now = Date.now();
  writeFileSync(
    join(d, "tg-subscribers.jsonl"),
    jsonl([
      {
        id: "1",
        profile: { firstName: "Ирина", lastName: "Петрова" },
        entryOrigin: "instagram",
        entryKey: "rol-hr",
        funnel: {
          startedAt: iso(now, 4),
          consentAt: iso(now, 4),
          materialAt: iso(now, 4),
          diagStartedAt: iso(now, 3),
          diagDoneAt: iso(now, 3),
          leadAt: iso(now, 1),
        },
        salesCard: { messageId: 5, status: "lead" },
        diag: { итог: { weak: ["нет времени и рук"] } },
      },
    ]),
  );
  const report = createReportBuilder({ storageDir: d, notifyChatId: "-1001234567890" });
  const { text, ownerSummary } = await report.build(new Date(now));
  assert.doesNotMatch(text, /—/, "em-dash не должен встречаться в отчёте Алёне");
  assert.doesNotMatch(ownerSummary, /—/, "em-dash не должен встречаться в сводке владельцу");
  rmSync(d, { recursive: true, force: true });
});
