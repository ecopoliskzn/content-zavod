import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBotInstance } from "../src/index.mjs";

const каталог = mkdtempSync(join(tmpdir(), "liga-bot-instance-"));

test.after(() => rmSync(каталог, { recursive: true, force: true }));

test("createBotInstance собирает инстанс из конфига без хардкодов", () => {
  const bot = createBotInstance({
    id: "fixture",
    storageDir: каталог,
    scenarios: [{ ключ: "test", слова: ["ТЕСТ"], где: ["директ"] }],
    texts: { welcome: "Привет, {имя}!" },
    materials: [{ key: "forbes", intro: "Держи подборку." }],
    sourceTagPrefix: "fixture",
    igRelay: { url: "https://ig-relay.example", relaySecret: "s1", igToken: "t1", appSecret: "app-secret" },
    tgRelay: { url: "https://tg-relay.example", relaySecret: "s2", botUsername: "fixturebot" },
  });

  assert.equal(bot.id, "fixture");
  assert.equal(bot.ig.подобрать("тест", "директ")?.сценарий.ключ, "test");
  assert.equal(bot.telegram.texts.render("welcome", { имя: "Аня" }), "Привет, Аня!");
  assert.equal(bot.telegram.botLink("ig-forbes"), "https://t.me/fixturebot?start=ig-forbes");
  assert.equal(bot.materialByEntry("ig-forbes")?.key, "forbes");
  assert.equal(bot.sourceTag("instagram"), "fixture:instagram");
  assert.ok(bot.ig.client, "IG relay client должен собраться из конфига");
  assert.ok(bot.telegram.client, "TG relay client должен собраться из конфига");
  assert.equal(bot.ig.queue.файл, join(каталог, "ig-queue.jsonl"));
});

test("без scenarios/materials/relay-конфигов инстанс всё равно собирается", () => {
  const bot = createBotInstance({ id: "minimal", storageDir: каталог });
  assert.deepEqual(bot.scenarios, []);
  assert.equal(bot.ig.client, null);
  assert.equal(bot.telegram.client, null);
});

test("без id или storageDir — явная ошибка, а не тихий хардкод по умолчанию", () => {
  assert.throws(() => createBotInstance({ storageDir: каталог }));
  assert.throws(() => createBotInstance({ id: "x" }));
});
