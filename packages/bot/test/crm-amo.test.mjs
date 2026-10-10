import test from "node:test";
import assert from "node:assert/strict";
import { createAmoClient } from "../src/crm/amo.mjs";

function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => handler(url, options);
  return () => {
    globalThis.fetch = original;
  };
}

test("pushLead без токена не бьёт по сети", async () => {
  const client = createAmoClient({ baseUrl: "https://example.amocrm.ru", getToken: () => "", pipelineId: 1 });
  const итог = await client.pushLead({ name: "Тест" }, "alyona:instagram");
  assert.equal(итог.ok, false);
  assert.match(итог.error, /токена/);
});

test("pushLead отправляет контакт+сделку с меткой источника и полями", async () => {
  let captured;
  const restore = mockFetch(async (url, options) => {
    captured = { url: String(url), body: JSON.parse(options.body), headers: options.headers };
    return {
      ok: true,
      json: async () => ({ _embedded: { unsorted: [{ _embedded: { leads: [{ id: 555 }] } }] } }),
    };
  });

  const client = createAmoClient({
    baseUrl: "https://example.amocrm.ru/",
    getToken: "tok-123",
    pipelineId: 42,
    statusId: 7,
    tagPrefix: "alyona",
    fields: { source: 100, task: 101, contactPhone: 200, contactUsername: 201 },
  });

  const итог = await client.pushLead(
    { id: "lead-1", name: "Ирина", phone: "+79990000000", username: "irina_hr", task: "Хочу консультацию" },
    "alyona:telegram",
  );

  restore();

  assert.equal(итог.ok, true);
  assert.equal(итог.id, 555);
  assert.equal(captured.headers.Authorization, "Bearer tok-123");
  assert.match(captured.url, /https:\/\/example\.amocrm\.ru\/api\/v4\/leads\/unsorted\/forms$/);

  const [форма] = captured.body;
  assert.equal(форма.pipeline_id, 42);
  assert.equal(форма.source_uid, "alyona-lead-1");
  assert.equal(форма._embedded.leads[0].status_id, 7);

  const сделкаПоля = Object.fromEntries(
    форма._embedded.leads[0].custom_fields_values.map((f) => [f.field_id, f.values[0].value]),
  );
  assert.equal(сделкаПоля[100], "alyona:telegram");
  assert.equal(сделкаПоля[101], "Хочу консультацию");

  const контактПоля = Object.fromEntries(
    форма._embedded.contacts[0].custom_fields_values.map((f) => [f.field_id, f.values[0].value]),
  );
  assert.equal(контактПоля[200], "+79990000000");
  assert.equal(контактПоля[201], "irina_hr");
});

test("pushLead возвращает ok:false при не-2xx ответе amo", async () => {
  const restore = mockFetch(async () => ({
    ok: false,
    status: 401,
    text: async () => "unauthorized",
  }));

  const client = createAmoClient({ baseUrl: "https://example.amocrm.ru", getToken: "tok", pipelineId: 1 });
  const итог = await client.pushLead({ name: "Тест" }, "alyona:instagram");

  restore();

  assert.equal(итог.ok, false);
  assert.match(итог.error, /401/);
});

test("pushLead ловит сетевую ошибку, а не бросает исключение", async () => {
  const restore = mockFetch(async () => {
    throw new Error("ECONNREFUSED");
  });

  const client = createAmoClient({ baseUrl: "https://example.amocrm.ru", getToken: "tok", pipelineId: 1 });
  const итог = await client.pushLead({ name: "Тест" }, "alyona:instagram");

  restore();

  assert.equal(итог.ok, false);
  assert.match(итог.error, /ECONNREFUSED/);
});

test("getToken как функция вызывается для получения свежего токена (задел под oauth-рефреш)", async () => {
  let calls = 0;
  const restore = mockFetch(async () => ({
    ok: true,
    json: async () => ({ _embedded: { unsorted: [{ _embedded: { leads: [{ id: 1 }] } }] } }),
  }));

  const client = createAmoClient({
    baseUrl: "https://example.amocrm.ru",
    getToken: async () => {
      calls += 1;
      return "fresh-token";
    },
    pipelineId: 1,
  });
  await client.pushLead({ name: "Тест" }, "alyona:instagram");

  restore();
  assert.equal(calls, 1);
});
