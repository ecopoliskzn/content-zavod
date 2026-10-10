import test from "node:test";
import assert from "node:assert/strict";

import { createTgRelayClient } from "../src/telegram/relay.mjs";

// Порт-проверка LL-кнопок: релей должен уметь проксировать ЛЮБОЙ метод Bot API
// (не только sendMessage), потому что инлайн-кнопки требуют answerCallbackQuery
// и editMessageReplyMarkup (см. apps/bot-instance/src/tg-flow.mjs).

function withFakeFetch(handler, run) {
  const оригинал = global.fetch;
  const запросы = [];
  global.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    запросы.push({ url, headers: init?.headers, body });
    const данные = handler(url, body) ?? { ok: true, result: {} };
    return { ok: true, status: 200, json: async () => данные };
  };
  return run(запросы).finally(() => {
    global.fetch = оригинал;
  });
}

test("call() проксирует произвольный метод Bot API через /api/<method>", async () => {
  await withFakeFetch(
    () => ({ ok: true, result: { done: true } }),
    async (запросы) => {
      const client = createTgRelayClient({ url: "https://relay.example/", relaySecret: "s3cr3t" });
      const res = await client.call("someArbitraryMethod", { a: 1 });
      assert.equal(res.ok, true);
      assert.equal(запросы[0].url, "https://relay.example/api/someArbitraryMethod");
      assert.equal(запросы[0].headers["x-relay-secret"], "s3cr3t");
      assert.deepEqual(запросы[0].body, { a: 1 });
    },
  );
});

test("sendMessage прокидывает reply_markup (inline_keyboard) из доп", async () => {
  await withFakeFetch(
    () => ({ ok: true, result: { message_id: 7 } }),
    async (запросы) => {
      const client = createTgRelayClient({ url: "https://relay.example", relaySecret: "s" });
      await client.sendMessage(42, "Привет", {
        reply_markup: { inline_keyboard: [[{ text: "Да", callback_data: "c:y" }]] },
      });
      assert.equal(запросы[0].url, "https://relay.example/api/sendMessage");
      assert.deepEqual(запросы[0].body.reply_markup, { inline_keyboard: [[{ text: "Да", callback_data: "c:y" }]] });
    },
  );
});

test("sendPhoto прокидывает photo/caption и reply_markup из кнопок", async () => {
  await withFakeFetch(
    () => ({ ok: true, result: { message_id: 9 } }),
    async (запросы) => {
      const client = createTgRelayClient({ url: "https://relay.example", relaySecret: "s" });
      await client.sendPhoto(42, "FILE_ID_1", "Подпись", [[{ text: "Кнопка", callback_data: "x" }]]);
      assert.equal(запросы[0].url, "https://relay.example/api/sendPhoto");
      assert.deepEqual(запросы[0].body, {
        chat_id: 42,
        photo: "FILE_ID_1",
        caption: "Подпись",
        reply_markup: { inline_keyboard: [[{ text: "Кнопка", callback_data: "x" }]] },
      });
    },
  );
});

test("sendPhoto без кнопок не шлёт reply_markup", async () => {
  await withFakeFetch(
    () => ({ ok: true, result: { message_id: 10 } }),
    async (запросы) => {
      const client = createTgRelayClient({ url: "https://relay.example", relaySecret: "s" });
      await client.sendPhoto(42, "FILE_ID_1", "Подпись");
      assert.deepEqual(запросы[0].body, { chat_id: 42, photo: "FILE_ID_1", caption: "Подпись" });
    },
  );
});

// Ритм подписей (owner 2026-09-28): жирный заголовок требует parse_mode HTML —
// sendMessage уже прокидывал доп-поля как есть, sendPhoto получил для этого 5-й параметр.
test("sendMessage прокидывает parse_mode из доп", async () => {
  await withFakeFetch(
    () => ({ ok: true, result: { message_id: 11 } }),
    async (запросы) => {
      const client = createTgRelayClient({ url: "https://relay.example", relaySecret: "s" });
      await client.sendMessage(42, "<b>Привет</b>", { parse_mode: "HTML" });
      assert.equal(запросы[0].body.parse_mode, "HTML");
    },
  );
});

test("sendPhoto прокидывает parse_mode из 5-го параметра вместе с кнопками", async () => {
  await withFakeFetch(
    () => ({ ok: true, result: { message_id: 12 } }),
    async (запросы) => {
      const client = createTgRelayClient({ url: "https://relay.example", relaySecret: "s" });
      await client.sendPhoto(42, "FILE_ID_1", "<b>Подпись</b>", [[{ text: "Кнопка", callback_data: "x" }]], {
        parse_mode: "HTML",
      });
      assert.deepEqual(запросы[0].body, {
        chat_id: 42,
        photo: "FILE_ID_1",
        caption: "<b>Подпись</b>",
        reply_markup: { inline_keyboard: [[{ text: "Кнопка", callback_data: "x" }]] },
        parse_mode: "HTML",
      });
    },
  );
});

test("answerCallbackQuery уходит методом answerCallbackQuery с callback_query_id", async () => {
  await withFakeFetch(
    () => ({ ok: true, result: true }),
    async (запросы) => {
      const client = createTgRelayClient({ url: "https://relay.example", relaySecret: "s" });
      const res = await client.answerCallbackQuery("cbq-1", { text: "Записал" });
      assert.equal(res.ok, true);
      assert.equal(запросы[0].url, "https://relay.example/api/answerCallbackQuery");
      assert.deepEqual(запросы[0].body, { callback_query_id: "cbq-1", text: "Записал" });
    },
  );
});

test("editMessageReplyMarkup по умолчанию снимает клавиатуру (пустой inline_keyboard)", async () => {
  await withFakeFetch(
    () => ({ ok: true, result: {} }),
    async (запросы) => {
      const client = createTgRelayClient({ url: "https://relay.example", relaySecret: "s" });
      await client.editMessageReplyMarkup(42, 7);
      assert.equal(запросы[0].url, "https://relay.example/api/editMessageReplyMarkup");
      assert.deepEqual(запросы[0].body, { chat_id: 42, message_id: 7, reply_markup: { inline_keyboard: [] } });
    },
  );
});

test("editMessageText прокидывает текст, кнопки и parse_mode (квиз/карточка продавца — редактирование на месте)", async () => {
  await withFakeFetch(
    () => ({ ok: true, result: { message_id: 7 } }),
    async (запросы) => {
      const client = createTgRelayClient({ url: "https://relay.example", relaySecret: "s" });
      await client.editMessageText(42, 7, "<b>Вопрос 2 из 7</b>", [[{ text: "1", callback_data: "d:q2:0" }]], {
        parse_mode: "HTML",
      });
      assert.equal(запросы[0].url, "https://relay.example/api/editMessageText");
      assert.deepEqual(запросы[0].body, {
        chat_id: 42,
        message_id: 7,
        text: "<b>Вопрос 2 из 7</b>",
        reply_markup: { inline_keyboard: [[{ text: "1", callback_data: "d:q2:0" }]] },
        parse_mode: "HTML",
      });
    },
  );
});

test("editMessageText без кнопок не шлёт reply_markup", async () => {
  await withFakeFetch(
    () => ({ ok: true, result: {} }),
    async (запросы) => {
      const client = createTgRelayClient({ url: "https://relay.example", relaySecret: "s" });
      await client.editMessageText(42, 7, "Просто текст");
      assert.deepEqual(запросы[0].body, { chat_id: 42, message_id: 7, text: "Просто текст" });
    },
  );
});

test("copyMessage прокидывает from_chat_id/message_id и доп (caption/reply_parameters/тема)", async () => {
  await withFakeFetch(
    () => ({ ok: true, result: { message_id: 13 } }),
    async (запросы) => {
      const client = createTgRelayClient({ url: "https://relay.example", relaySecret: "s" });
      await client.copyMessage(42, -100999, 501, {
        caption: "💬 Ирина: привет",
        parse_mode: "HTML",
        reply_parameters: { message_id: 900 },
        message_thread_id: 5,
      });
      assert.equal(запросы[0].url, "https://relay.example/api/copyMessage");
      assert.deepEqual(запросы[0].body, {
        chat_id: 42,
        from_chat_id: -100999,
        message_id: 501,
        caption: "💬 Ирина: привет",
        parse_mode: "HTML",
        reply_parameters: { message_id: 900 },
        message_thread_id: 5,
      });
    },
  );
});

test("copyMessage без доп — только обязательные поля", async () => {
  await withFakeFetch(
    () => ({ ok: true, result: { message_id: 14 } }),
    async (запросы) => {
      const client = createTgRelayClient({ url: "https://relay.example", relaySecret: "s" });
      await client.copyMessage(42, -100999, 501);
      assert.deepEqual(запросы[0].body, { chat_id: 42, from_chat_id: -100999, message_id: 501 });
    },
  );
});

test("вызвать остаётся алиасом call() (обратная совместимость)", () => {
  const client = createTgRelayClient({ url: "https://relay.example", relaySecret: "s" });
  assert.equal(client.вызвать, client.call);
});

// BUG-041: релей (Cloudflare Worker) наблюдал скачки латентности 0.1–7.7с. Раньше call()
// был голым fetch без таймаута — зависший вызов держал квиз/карточку продавца неопределённо
// долго, а вызывающий код (tg-flow.mjs) не мог отличить «релей ещё думает» от «сбой».

function withRelayClient(fetchImpl, clientOpts, run) {
  const оригинал = global.fetch;
  global.fetch = fetchImpl;
  const client = createTgRelayClient({ url: "https://relay.example", relaySecret: "s3cr3t-тайна", ...clientOpts });
  return run(client).finally(() => {
    global.fetch = оригинал;
  });
}

test("call() не бросает при таймауте релея — AbortController обрывает зависший fetch, ok:false/retryable", async () => {
  await withRelayClient(
    (url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
    { timeoutMs: 20 },
    async (client) => {
      const res = await client.call("editMessageText", { chat_id: 1, message_id: 2, text: "вопрос 4 из 7" });
      assert.equal(res.ok, false);
      assert.equal(res.status, 0);
      assert.equal(res.retryable, true);
      assert.equal(res.данные.description, "timeout");
    },
  );
});

test("call() не бросает при сетевой ошибке fetch (не таймаут) — ok:false/retryable, описание из ошибки", async () => {
  await withRelayClient(
    async () => {
      throw new Error("network down");
    },
    {},
    async (client) => {
      const res = await client.call("sendMessage", { chat_id: 1, text: "привет" });
      assert.equal(res.ok, false);
      assert.equal(res.status, 0);
      assert.equal(res.retryable, true);
      assert.equal(res.данные.description, "network down");
    },
  );
});

test("call() статус 5xx — retryable:true (имеет смысл повторить)", async () => {
  await withRelayClient(
    async () => ({ ok: false, status: 502, json: async () => ({ ok: false, description: "Bad Gateway" }) }),
    {},
    async (client) => {
      const res = await client.call("sendMessage", { chat_id: 1, text: "х" });
      assert.equal(res.ok, false);
      assert.equal(res.status, 502);
      assert.equal(res.retryable, true);
    },
  );
});

test("call() статус 4xx — retryable:false (повтор не поможет)", async () => {
  await withRelayClient(
    async () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: "Bad Request: message is not modified" }),
    }),
    {},
    async (client) => {
      const res = await client.call("editMessageText", { chat_id: 1, message_id: 2 });
      assert.equal(res.ok, false);
      assert.equal(res.status, 400);
      assert.equal(res.retryable, false);
    },
  );
});

test("call() успех — logger не вызывается", async () => {
  const вызовы = [];
  await withRelayClient(
    async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: {} }) }),
    { logger: (...args) => вызовы.push(args) },
    async (client) => {
      await client.call("sendMessage", { chat_id: 1, text: "ок" });
      assert.equal(вызовы.length, 0);
    },
  );
});

test("call() логирует сбой как (метод, статус, описание) — без тела запроса и без секрета", async () => {
  const вызовы = [];
  await withRelayClient(
    async () => ({ ok: false, status: 500, json: async () => ({ ok: false, description: "Internal Server Error" }) }),
    { logger: (...args) => вызовы.push(args) },
    async (client) => {
      const секретныйТекст = "текст сообщения клиента, который не должен попасть в лог";
      const res = await client.call("sendMessage", { chat_id: 1, text: секретныйТекст });
      assert.equal(res.ok, false);
      assert.equal(вызовы.length, 1);
      const [method, status, description] = вызовы[0];
      assert.equal(method, "sendMessage");
      assert.equal(status, 500);
      assert.equal(description, "Internal Server Error");
      const строкаЛога = вызовы[0].map(String).join(" ");
      assert.doesNotMatch(строкаЛога, /s3cr3t-тайна/, "секрет релея не должен попасть в лог");
      assert.doesNotMatch(строкаЛога, /текст сообщения клиента/, "текст сообщения не должен попасть в лог");
    },
  );
});

test("call() без явного logger по умолчанию пишет в console.error, но не бросает", async () => {
  const оригинал = console.error;
  const вызовы = [];
  console.error = (...args) => вызовы.push(args);
  try {
    await withRelayClient(
      async () => ({ ok: false, status: 500, json: async () => ({ ok: false, description: "Internal Server Error" }) }),
      {},
      async (client) => {
        const res = await client.call("sendMessage", { chat_id: 1, text: "х" });
        assert.equal(res.ok, false);
      },
    );
    assert.equal(вызовы.length, 1, "по умолчанию сбой должен уйти в console.error");
  } finally {
    console.error = оригинал;
  }
});
