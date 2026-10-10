// Экземпляр бота «Экополиса» поверх общего движка (packages/bot).
//
// Движок перенесён из наших боевых ботов: подбор кодового слова, очередь событий
// Instagram, хранилище подписчиков, приём заявок. Здесь только настройка: где лежат
// данные, какие сценарии, какие тексты, через что ходить наружу.
//
// ПЕРСОНАЛЬНЫЕ ДАННЫЕ. Подписчики, переписка и заявки лежат в каталоге data/leads на
// сервере в России, первичная запись идёт туда. В дубль расписания на компьютере
// оператора этот каталог не попадает никогда.

import path from "node:path";
import { createBotInstance, createLeadStore } from "#bot";
import { PROJECT_ROOT, dataPath, env } from "../lib/env.mjs";
import { readJson } from "../lib/files.mjs";

let instance = null;

export function bot() {
  if (instance) return instance;
  const texts = readJson(path.join(PROJECT_ROOT, "bot", "texts.json"), {});
  const materials = readJson(path.join(PROJECT_ROOT, "bot", "materials.json"), []);
  const core = createBotInstance({
    id: "ecopolis",
    storageDir: dataPath("leads"),
    scenarios: path.join(PROJECT_ROOT, "bot", "scenarios"),
    texts,
    materials,
    sourceTagPrefix: "ecopolis",
    igRelay: {
      url: env("IG_RELAY_URL"),
      relaySecret: env("IG_RELAY_SECRET"),
      igToken: env("IG_TOKEN"),
      // Подпись входящих событий. Первый месяц события пересылает приложение
      // исполнителя и подписывает их отдельным секретом пары (IG_FORWARD_SECRET):
      // секрет чужого приложения на сервер клиента не попадает. После переезда на
      // своё приложение Meta подпись проверяется его секретом (IG_APP_SECRET).
      appSecret: env("IG_APP_SECRET"),
      verifyToken: env("IG_WEBHOOK_VERIFY_TOKEN"),
    },
    tgRelay: { url: env("TG_RELAY_URL"), relaySecret: env("TG_RELAY_SECRET"), botUsername: env("TG_BOT_USERNAME") },
  });
  const leads = createLeadStore({ storageDir: dataPath("leads"), sourceTagPrefix: "ecopolis" });
  instance = { ...core, leads, texts, consentVersion: texts.consentVersion || "1" };
  return instance;
}

/** Для тестов. */
export function _resetBot() {
  instance = null;
}
