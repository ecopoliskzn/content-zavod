import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createIgQueue } from "../src/ig/queue.mjs";

// Порт lib/ig/queue.test.mjs: файл теперь параметр фабрики, а не process.env,
// иначе тесты одного процесса делили бы очередь.
const ВРЕМЕННЫЙ = path.join(os.tmpdir(), `liga-bot-ig-queue-test-${process.pid}.jsonl`);
const { положить, взять, убрать } = createIgQueue(ВРЕМЕННЫЙ);

function очистить() {
  if (fs.existsSync(ВРЕМЕННЫЙ)) fs.unlinkSync(ВРЕМЕННЫЙ);
}

const событие = (id, доп = {}) => ({
  id,
  вид: "комментарий",
  текст: "тестовое событие",
  отId: "123",
  когда: new Date(0).toISOString(),
  принято: new Date(0).toISOString(),
  ...доп,
});

test.after(очистить);

test("пустая очередь не падает", () => {
  очистить();
  assert.deepEqual(взять(), []);
  assert.equal(убрать(["чего-нет"]), 0);
});

test("событие кладётся и забирается", () => {
  очистить();
  положить(событие("com-1"));
  const все = взять();
  assert.equal(все.length, 1);
  assert.equal(все[0].текст, "тестовое событие");
});

test("повторная доставка того же события не двоится", () => {
  очистить();
  положить(событие("com-1"));
  положить(событие("com-1"));
  положить(событие("com-1", { текст: "другой текст" }));
  assert.equal(взять().length, 1);
});

test("убираем только названное поимённо", () => {
  очистить();
  положить(событие("com-1"));
  положить(событие("com-2"));
  положить(событие("com-3"));
  const убрано = убрать(["com-1", "com-3"]);
  assert.equal(убрано, 2);
  const осталось = взять();
  assert.equal(осталось.length, 1);
  assert.equal(осталось[0].id, "com-2");
});

test("очередь не растёт без предела", () => {
  очистить();
  for (let i = 0; i < 4000; i++) положить(событие("com-" + i, { текст: "тестовое событие, немного длиннее" }));
  const все = взять();
  assert.ok(все.length <= 1500, `в очереди ${все.length} записей, обрезка не сработала`);
  assert.equal(все[все.length - 1].id, "com-3999");
  очистить();
});
