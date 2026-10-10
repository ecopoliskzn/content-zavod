import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTgStore } from "../src/telegram/store.mjs";

// Порт lib/telegram/store.test.mjs: subsFile/eventsFile теперь параметры фабрики,
// а не process.env.
const каталог = mkdtempSync(join(tmpdir(), "liga-bot-tg-store-"));
const { upsertSubscriber, findSubscriber, findByCardMessageId, files } = createTgStore({
  subsFile: join(каталог, "subs.jsonl"),
  eventsFile: join(каталог, "events.jsonl"),
});

test.after(() => rmSync(каталог, { recursive: true, force: true }));

test("первый контакт проставляет дату подписки", async () => {
  const с = await upsertSubscriber("111", { firstName: "Оля", username: "olgakruglove" });
  assert.ok(с.subscribedAt, "дата первого контакта обязана появиться сама");
  assert.ok(Date.now() - new Date(с.subscribedAt).getTime() < 5000, "дата должна быть сегодняшней");
});

test("повторный контакт дату первого не переписывает", async () => {
  const первый = await findSubscriber("111");
  const второй = await upsertSubscriber("111", { lastContactAt: new Date().toISOString() });
  assert.equal(второй.subscribedAt, первый.subscribedAt, "иначе все подписчики вечно «новые»");
});

test("имя собирается из частей, которые присылает Telegram", async () => {
  const с = await upsertSubscriber("222", { firstName: "Артур", lastName: "Аржаков" });
  assert.equal(с.name, "Артур Аржаков");
});

test("смена имени в Telegram обновляет собранное имя", async () => {
  await upsertSubscriber("333", { firstName: "Женя" });
  const после = await upsertSubscriber("333", { firstName: "Евгений", lastName: "Блок" });
  assert.equal(после.name, "Евгений Блок");
});

test("патч без имени не стирает импортированное имя", async () => {
  await upsertSubscriber("444", { name: "Тестовое Имя" });
  const после = await upsertSubscriber("444", { status: "blocked" });
  assert.equal(после.name, "Тестовое Имя");
});

test("буфер событий и подписчиков создаётся в заданном каталоге", () => {
  assert.ok(existsSync(files.subsFile), "иначе тест проверял бы боевой файл");
});

test("одновременные записи не стирают друг друга", async () => {
  await Promise.all([
    upsertSubscriber("222", { consent: { given: true, at: "2026-09-19T10:00:00Z", version: "v1" } }),
    upsertSubscriber("222", { lastContactAt: "2026-09-19T10:00:01Z" }),
    upsertSubscriber("222", { tags: ["вход-tg-test"] }),
  ]);
  const с = await findSubscriber("222");
  assert.equal(с?.consent?.given, true, "согласие потерялось");
  assert.equal(с?.lastContactAt, "2026-09-19T10:00:01Z");
  assert.ok(с?.tags.includes("вход-tg-test"));
});

test("шаг заявки получает отметку времени сам", async () => {
  const с = await upsertSubscriber("333", { lead: { mission: "test", step: "name" } });
  assert.ok(с.lead?.at, "без отметки черновик не сгорит");
});

test("funnel: время первого наступления шага не переписывается более поздним патчем", async () => {
  await upsertSubscriber("666", { funnel: { startedAt: "2026-09-28T10:00:00.000Z" } });
  const после = await upsertSubscriber("666", {
    funnel: { startedAt: "2026-09-28T11:00:00.000Z", consentAt: "2026-09-28T10:05:00.000Z" },
  });
  assert.equal(после.funnel.startedAt, "2026-09-28T10:00:00.000Z", "первое наступление шага — не последнее");
  assert.equal(после.funnel.consentAt, "2026-09-28T10:05:00.000Z", "новый шаг воронки добавляется");
});

test("salesCard: патч сливается с текущей карточкой, а не заменяет её целиком", async () => {
  await upsertSubscriber("777", { salesCard: { messageId: 501, status: "diag" } });
  const после = await upsertSubscriber("777", { salesCard: { status: "lead" } });
  assert.equal(после.salesCard.messageId, 501, "messageId карточки не должен теряться при обновлении статуса");
  assert.equal(после.salesCard.status, "lead");

  const взяли = await upsertSubscriber("777", { salesCard: { takenBy: "Сотрудник", takenAt: "2026-09-28T12:00:00.000Z" } });
  assert.equal(взяли.salesCard.messageId, 501);
  assert.equal(взяли.salesCard.status, "lead");
  assert.equal(взяли.salesCard.takenBy, "Сотрудник");
});

test("findByCardMessageId: находит подписчика по messageId его карточки продавца", async () => {
  await upsertSubscriber("888", { salesCard: { messageId: 4242, status: "lead" } });
  const найден = await findByCardMessageId(4242);
  assert.equal(найден?.id, "888");

  assert.equal(await findByCardMessageId(999999), undefined, "чужой/несуществующий messageId — undefined");
});

test("findByCardMessageId: обновлённая карточка (editMessageText на месте) находится по тому же messageId", async () => {
  await upsertSubscriber("889", { salesCard: { messageId: 4300, status: "diag" } });
  await upsertSubscriber("889", { salesCard: { status: "lead" } }); // messageId сохраняется патчем (см. тест выше)
  const найден = await findByCardMessageId(4300);
  assert.equal(найден?.id, "889");
  assert.equal(найден?.salesCard?.status, "lead");
});

test("отзыв согласия стирает телефон, возврат не возвращает согласие", async () => {
  await upsertSubscriber("555", { phone: "+79001234567", consent: { given: true, at: "x", version: "v" }, lead: { step: "name" } });
  const с = await upsertSubscriber("555", { status: "unsubscribed", consent: { given: false, at: "y", version: "v" }, phone: undefined, lead: null });
  assert.equal(с.phone, undefined);
  assert.equal(с.consent?.given, false);
  assert.equal(с.lead, null);
});
