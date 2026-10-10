import test from "node:test";
import assert from "node:assert/strict";

import { withOutgoingLog } from "../src/telegram/outgoing-log.mjs";

// Журнал исходящих (воронка v2, ВОРОНКА-V2, раздел "OUTGOING LOG"): unit-тест
// обёртки в изоляции (без сети/реле) — фейковый внутренний клиент + фейковый store.logEvent.
// Интеграционные тесты Live Reply Relay (apps/bot-instance/test/relay-reply.test.mjs) проверяют
// её же поведение через реальный bot.telegram.client, собранный createBotInstance.

function fakeClient(overrides = {}) {
  return {
    sendMessage: async (chatId, text) => ({ ok: true, данные: { result: { message_id: 501 } } }),
    sendPhoto: async (chatId, fileId, caption) => ({ ok: true, данные: { result: { message_id: 502 } } }),
    editMessageText: async (chatId, messageId, text) => ({ ok: true, данные: { result: { message_id: messageId } } }),
    copyMessage: async () => ({ ok: true, данные: { result: { message_id: 503 } } }),
    answerCallbackQuery: async () => ({ ok: true }),
    editMessageReplyMarkup: async () => ({ ok: true }),
    call: async () => ({ ok: true, данные: {} }),
    ...overrides,
  };
}

function fakeStore() {
  const события = [];
  return { store: { logEvent: async (e) => void события.push(e) }, события };
}

test("null-клиент/null-store проходят насквозь без ошибок", () => {
  assert.equal(withOutgoingLog(null, { logEvent: async () => {} }), null);
  const client = fakeClient();
  assert.equal(withOutgoingLog(client, null), client);
});

test("успешный sendMessage пишет в журнал {ушло:{от:'бот', method, messageId}}", async () => {
  const { store, события } = fakeStore();
  const client = withOutgoingLog(fakeClient(), store);

  await client.sendMessage("111", "Привет");

  assert.equal(события.length, 1);
  assert.deepEqual(события[0], {
    ушло: { чат: "111", текст: "Привет", от: "бот", method: "sendMessage", messageId: 501 },
  });
});

test("неуспешный вызов (res.ok=false) в журнал не пишется", async () => {
  const { store, события } = fakeStore();
  const client = withOutgoingLog(fakeClient({ sendMessage: async () => ({ ok: false, status: 403 }) }), store);

  const res = await client.sendMessage("111", "Привет");

  assert.equal(res.ok, false);
  assert.equal(события.length, 0);
});

test("текст обрезается до 500 символов", async () => {
  const { store, события } = fakeStore();
  const client = withOutgoingLog(fakeClient(), store);
  const длинныйТекст = "а".repeat(600);

  await client.sendMessage("111", длинныйТекст);

  assert.equal(события[0].ушло.текст.length, 500);
});

test("sendPhoto логируется по caption (не по photo/file_id)", async () => {
  const { store, события } = fakeStore();
  const client = withOutgoingLog(fakeClient(), store);

  await client.sendPhoto("111", "FILE_ID_SECRET", "Подпись к фото");

  assert.equal(события[0].ушло.текст, "Подпись к фото");
  assert.doesNotMatch(JSON.stringify(события[0]), /FILE_ID_SECRET/, "file_id — не текст переписки, в лог не идёт");
});

test("editMessageText логируется как метод editMessageText", async () => {
  const { store, события } = fakeStore();
  const client = withOutgoingLog(fakeClient(), store);

  await client.editMessageText("111", 7, "Вопрос 2 из 7", [[{ text: "1", callback_data: "d:q2:0" }]]);

  assert.equal(события[0].ушло.method, "editMessageText");
  assert.equal(события[0].ушло.messageId, 7);
  assert.equal(события[0].ушло.текст, "Вопрос 2 из 7");
});

test("copyMessage логируется по caption из доп, а не по контенту", async () => {
  const { store, события } = fakeStore();
  const client = withOutgoingLog(fakeClient(), store);

  await client.copyMessage("111", "-100999", 501, { caption: "💬 Ирина: привет" });

  assert.equal(события[0].ушло.method, "copyMessage");
  assert.equal(события[0].ушло.чат, "111");
  assert.equal(события[0].ушло.текст, "💬 Ирина: привет");
});

test("copyMessage без caption в доп логируется с пустым текстом, но не падает", async () => {
  const { store, события } = fakeStore();
  const client = withOutgoingLog(fakeClient(), store);

  await client.copyMessage("111", "-100999", 501);

  assert.equal(события.length, 1);
  assert.equal(события[0].ушло.текст, "");
});

test('маркер {от:"человек"} уходит в журнал и снимается перед вызовом настоящего клиента (Telegram его не видит)', async () => {
  const { store, события } = fakeStore();
  const вызовы = [];
  const client = withOutgoingLog(
    fakeClient({
      sendMessage: async (...args) => {
        вызовы.push(args);
        return { ok: true, данные: { result: { message_id: 501 } } };
      },
    }),
    store,
  );

  await client.sendMessage("111", "Отвечаю от себя", { от: "человек", parse_mode: "HTML" });

  assert.equal(события[0].ушло.от, "человек");
  // Реальному client.sendMessage "от" не передаётся — только то, что реально идёт в Bot API.
  assert.deepEqual(вызовы[0], ["111", "Отвечаю от себя", { parse_mode: "HTML" }]);
});

test('без маркера "от" по умолчанию — "бот"', async () => {
  const { store, события } = fakeStore();
  const client = withOutgoingLog(fakeClient(), store);

  await client.sendMessage("111", "Сценарный текст", { parse_mode: "HTML" });

  assert.equal(события[0].ушло.от, "бот");
});

test("answerCallbackQuery и editMessageReplyMarkup не логируются (не переписка с человеком)", async () => {
  const { store, события } = fakeStore();
  const client = withOutgoingLog(fakeClient(), store);

  await client.answerCallbackQuery("cbq-1", { text: "Записал" });
  await client.editMessageReplyMarkup("111", 7);

  assert.equal(события.length, 0);
});

test("call/вызвать остаются необёрнутыми (используются только внутри relay.mjs)", async () => {
  const original = fakeClient();
  const client = withOutgoingLog(original, fakeStore().store);
  assert.equal(client.call, original.call);
});

test("ни одна запись журнала не содержит секретов релея/токена (в аргументы они не передаются)", async () => {
  const { store, события } = fakeStore();
  const client = withOutgoingLog(fakeClient(), store);

  await client.sendMessage("111", "обычное сообщение клиенту");

  const строка = JSON.stringify(события);
  assert.doesNotMatch(строка, /relaySecret|BOT_TOKEN|s3cr3t/i);
});
