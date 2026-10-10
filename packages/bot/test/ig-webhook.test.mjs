import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { подписьВерна, подтверждениеПодписки, идентификаторыАккаунтов, разобратьСобытия } from "../src/ig/webhook.mjs";

const СЕКРЕТ = "test-app-secret";

function подписать(тело) {
  return "sha256=" + crypto.createHmac("sha256", СЕКРЕТ).update(тело, "utf8").digest("hex");
}

test("подпись проверяется корректно", () => {
  const тело = JSON.stringify({ entry: [] });
  assert.equal(подписьВерна(тело, подписать(тело), СЕКРЕТ), true);
  assert.equal(подписьВерна(тело, "sha256=deadbeef", СЕКРЕТ), false);
  assert.equal(подписьВерна(тело, null, СЕКРЕТ), false);
  assert.equal(подписьВерна(тело, подписать(тело), ""), false);
});

test("подтверждение подписки отвечает challenge только при совпавшем токене", () => {
  const ок = подтверждениеПодписки({ mode: "subscribe", token: "t1", challenge: "c1", verifyToken: "t1" });
  assert.deepEqual(ок, { ok: true, challenge: "c1" });
  const отказ = подтверждениеПодписки({ mode: "subscribe", token: "чужой", challenge: "c1", verifyToken: "t1" });
  assert.equal(отказ.ok, false);
});

test("идентификаторыАккаунтов достаёт entry.id для маршрутизации общего вебхука (D-012)", () => {
  const тело = JSON.stringify({ entry: [{ id: "111" }, { id: "222" }] });
  assert.deepEqual(идентификаторыАккаунтов(тело), ["111", "222"]);
  assert.deepEqual(идентификаторыАккаунтов("не json"), []);
});

test("разбирает комментарии и директ-сообщения в события очереди", () => {
  const тело = JSON.stringify({
    entry: [
      {
        id: "acc-1",
        time: 1000,
        changes: [
          { field: "comments", value: { id: "c1", text: "АКФИКС", from: { id: "u1", username: "u1name" }, media: { id: "m1" } } },
        ],
        messaging: [
          { message: { mid: "msg-1", text: "привет" }, sender: { id: "u2" }, timestamp: 2000 },
          // эхо от самого аккаунта — должно быть отфильтровано
          { message: { mid: "msg-2", text: "наш ответ" }, sender: { id: "acc-1" }, timestamp: 2000 },
        ],
      },
    ],
  });

  const события = разобратьСобытия(тело);
  assert.equal(события.length, 2);
  assert.equal(события[0].id, "com-c1");
  assert.equal(события[0].вид, "комментарий");
  assert.equal(события[0].отИмя, "u1name");
  assert.equal(события[1].id, "msg-msg-1");
  assert.equal(события[1].вид, "директ");
});

test("фильтрует события по accountId (D-012: общий вебхук на несколько инстансов)", () => {
  const тело = JSON.stringify({
    entry: [
      { id: "acc-1", changes: [{ field: "comments", value: { id: "c1", text: "x", from: { id: "u1" } } }] },
      { id: "acc-2", changes: [{ field: "comments", value: { id: "c2", text: "y", from: { id: "u2" } } }] },
    ],
  });
  const события = разобратьСобытия(тело, { accountId: "acc-2" });
  assert.equal(события.length, 1);
  assert.equal(события[0].id, "com-c2");
});

test("разбор мусорного тела не падает", () => {
  assert.deepEqual(разобратьСобытия("не json"), []);
});
