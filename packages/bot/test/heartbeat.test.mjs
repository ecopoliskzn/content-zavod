import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHeartbeat } from "../src/heartbeat.mjs";

const каталог = mkdtempSync(join(tmpdir(), "liga-bot-heartbeat-"));
test.after(() => rmSync(каталог, { recursive: true, force: true }));

test("createHeartbeat требует file", () => {
  assert.throws(() => createHeartbeat({}));
});

test("record() без ошибки — lastRun/lastOk совпадают, lastError null", () => {
  const hb = createHeartbeat({ file: join(каталог, "a.json") });
  const запись = hb.record("igQueuePoll");
  assert.ok(запись.lastRun);
  assert.equal(запись.lastOk, запись.lastRun);
  assert.equal(запись.lastError, null);
});

test("record() с ошибкой — lastError записан, lastOk не трогается (остаётся null, если успеха ещё не было)", () => {
  const hb = createHeartbeat({ file: join(каталог, "b.json") });
  const запись = hb.record("followupPoll", new Error("релей не отвечает"));
  assert.ok(запись.lastRun);
  assert.equal(запись.lastOk, null);
  assert.equal(запись.lastError, "релей не отвечает");
});

test("lastOk не откатывается назад: сбой после успеха сохраняет прежний lastOk", () => {
  const hb = createHeartbeat({ file: join(каталог, "c.json") });
  const успех = hb.record("igQueuePoll");
  const сбой = hb.record("igQueuePoll", "сбой сети");
  assert.equal(сбой.lastOk, успех.lastOk, "lastOk должен остаться от последнего УСПЕШНОГО прохода");
  assert.equal(сбой.lastError, "сбой сети");
  assert.notEqual(сбой.lastRun, успех.lastRun, "lastRun обновляется на каждый проход, даже сбойный");
});

test("следующий успех после сбоя очищает lastError и обновляет lastOk", () => {
  const hb = createHeartbeat({ file: join(каталог, "d.json") });
  hb.record("igQueuePoll", "сбой");
  const после = hb.record("igQueuePoll");
  assert.equal(после.lastError, null);
  assert.ok(после.lastOk);
});

test("несколько циклов хранятся независимо в одном файле", () => {
  const file = join(каталог, "e.json");
  const hb = createHeartbeat({ file });
  hb.record("igQueuePoll");
  hb.record("followupPoll", "упал");

  const state = hb.state();
  assert.ok(state.igQueuePoll);
  assert.ok(state.followupPoll);
  assert.equal(state.followupPoll.lastError, "упал");
  assert.equal(state.igQueuePoll.lastError, null);
});

test("summary() компактная: ok/ageSec/lastError, без лишних полей", () => {
  const file = join(каталог, "f.json");
  const hb = createHeartbeat({ file });
  hb.record("igQueuePoll");
  hb.record("followupPoll", "релей не отвечает");

  const summary = hb.summary();
  assert.equal(summary.igQueuePoll.ok, true);
  assert.equal(typeof summary.igQueuePoll.ageSec, "number");
  assert.equal(summary.igQueuePoll.lastError, null);

  assert.equal(summary.followupPoll.ok, false);
  assert.equal(summary.followupPoll.lastError, "релей не отвечает");
});

test("длинная ошибка обрезается (не раздувает файл на VPS)", () => {
  const file = join(каталог, "g.json");
  const hb = createHeartbeat({ file });
  const запись = hb.record("igQueuePoll", "x".repeat(1000));
  assert.equal(запись.lastError.length, 300);
});

test("файл переживает создание нового createHeartbeat (состояние на диске, не в памяти процесса)", () => {
  const file = join(каталог, "h.json");
  createHeartbeat({ file }).record("igQueuePoll");
  const второй = createHeartbeat({ file });
  assert.ok(второй.state().igQueuePoll);
  assert.match(readFileSync(file, "utf8"), /igQueuePoll/);
});

test("битый JSON в файле не роняет запись следующего тика", () => {
  const file = join(каталог, "i.json");
  const hb1 = createHeartbeat({ file });
  hb1.record("igQueuePoll");
  writeFileSync(file, "{не json");
  const hb2 = createHeartbeat({ file });
  assert.doesNotThrow(() => hb2.record("igQueuePoll"));
});
