// @zavod/bot — общий движок ботов. Фаза 1: IG-ядро (кодовые слова,
// досылки, вебхук) + минимум TG (хранилище подписчиков, вход по deep-link, тексты,
// отправка через релей). Экземпляр (по одному на клиента) собирается конфигом,
// никакой бизнес-логики конкретного сайта здесь нет.

import path from "node:path";

import { подобрать, персональнаяМетка, подставить, норма } from "./ig/match.mjs";
import { загрузитьСценарии } from "./ig/scenarios.mjs";
import { createIgQueue } from "./ig/queue.mjs";
import { createIgRelayClient } from "./ig/relay.mjs";
import { подписьВерна, подтверждениеПодписки, идентификаторыАккаунтов, разобратьСобытия } from "./ig/webhook.mjs";

import { createTgStore } from "./telegram/store.mjs";
import { parseEntry, botLink } from "./telegram/entry.mjs";
import { createTexts } from "./telegram/texts.mjs";
import { createTgRelayClient } from "./telegram/relay.mjs";
import { withOutgoingLog } from "./telegram/outgoing-log.mjs";

import { createAmoClient } from "./crm/amo.mjs";
import { createLeadStore } from "./leads.mjs";
import { createDiagEngine } from "./telegram/diag.mjs";
import { createFollowupEngine } from "./telegram/followup.mjs";
import { createReportBuilder } from "./report.mjs";
import { createHeartbeat } from "./heartbeat.mjs";

/**
 * @typedef {object} BotInstanceConfig
 * @property {string} id идентификатор инстанса, например "demo"
 * @property {string} storageDir каталог хранилища на VPS, например "/opt/leads-demo"
 * @property {string[]|object[]|string} [scenarios] сценарии кодовых слов IG: массив
 *   объектов или путь к директории с *.json (см. ig/scenarios.mjs)
 * @property {object} [texts] словарь текстов TG-бота (см. telegram/texts.mjs)
 * @property {object[]} [materials] материалы, отдаваемые по кодовому слову/deep-link;
 *   каждый — { key, ... }; сама выдача (файл/ссылка) остаётся за приложением-потребителем
 * @property {string} [envPrefix] префикс имён env-переменных инстанса, например "DEMO_"
 *   (используется приложением-потребителем при чтении секретов; сам пакет process.env
 *   не читает — секреты передаются явно через relay-поля ниже)
 * @property {{ id: string }[]} [recipients] получатели уведомлений (chat id в TG)
 * @property {string} [sourceTagPrefix] префикс метки источника лида, например "demo"
 *   (используется как "<sourceTagPrefix>:<площадка>")
 * @property {{ url: string, relaySecret?: string, igToken?: string, appSecret?: string, verifyToken?: string }} [igRelay]
 * @property {{ url: string, relaySecret?: string, botUsername?: string }} [tgRelay]
 */

/**
 * Собирает бота конкретного инстанса из конфига. Ничего не хардкодит: пути хранилища,
 * сценарии, тексты, релеи — всё приходит через config.
 * @param {BotInstanceConfig} config
 */
export function createBotInstance(config = {}) {
  const { id, storageDir, scenarios, texts, materials = [], recipients = [], sourceTagPrefix, igRelay, tgRelay } = config;
  if (!id) throw new TypeError("createBotInstance: нужен id инстанса");
  if (!storageDir) throw new TypeError("createBotInstance: нужен storageDir");

  const сценарииСписок = scenarios ? загрузитьСценарии(scenarios) : [];
  const материалыПоКлючу = new Map(materials.map((m) => [String(m.key), m]));
  // Метка входа несёт канал впереди материала ("yt-forbes"): режем по первому дефису,
  // как materials.ts в исходном проекте (materialByEntry), плюс проверка ключа целиком —
  // для голого имени материала без канала ("forbes").
  const materialByEntry = (key) => {
    const k = String(key).toLowerCase();
    const tail = k.includes("-") ? k.slice(k.indexOf("-") + 1) : k;
    return материалыПоКлючу.get(tail) || материалыПоКлючу.get(k);
  };

  const igQueue = createIgQueue(path.join(storageDir, "ig-queue.jsonl"));
  const igClient = igRelay?.url
    ? createIgRelayClient({ url: igRelay.url, relaySecret: igRelay.relaySecret, igToken: igRelay.igToken })
    : null;

  const tgStore = createTgStore({
    subsFile: path.join(storageDir, "tg-subscribers.jsonl"),
    eventsFile: path.join(storageDir, "tg-events.jsonl"),
  });
  // OUTGOING LOG (воронка v2, ВОРОНКА-V2): обёртка добавляет запись в tgStore
  // (tg-events.jsonl) на каждую успешную отправку клиенту, один раз здесь — см.
  // telegram/outgoing-log.mjs. bot.telegram.client остаётся null, если релей не настроен
  // (withOutgoingLog(null, …) возвращает null как есть).
  const tgClient = withOutgoingLog(
    tgRelay?.url ? createTgRelayClient({ url: tgRelay.url, relaySecret: tgRelay.relaySecret }) : null,
    tgStore,
  );
  const textsApi = createTexts(texts);

  /** Метка источника лида: "<sourceTagPrefix>:<площадка>" (D-013). */
  function sourceTag(площадка) {
    return sourceTagPrefix ? `${sourceTagPrefix}:${площадка}` : площадка;
  }

  return {
    id,
    storageDir,
    scenarios: сценарииСписок,
    materials,
    recipients,

    ig: {
      подобрать: (text, где) => подобрать(text, сценарииСписок, где),
      персональнаяМетка,
      подставить,
      норма,
      queue: igQueue,
      client: igClient,
      webhook: {
        подписьВерна: (тело, заголовок) => подписьВерна(тело, заголовок, igRelay?.appSecret),
        подтверждениеПодписки: (params) => подтверждениеПодписки({ ...params, verifyToken: igRelay?.verifyToken }),
        идентификаторыАккаунтов,
        разобратьСобытия,
      },
    },

    telegram: {
      store: tgStore,
      client: tgClient,
      texts: textsApi,
      parseEntry: (text, опции = {}) => parseEntry(text, { materialByEntry, ...опции }),
      botLink: (key) => botLink(tgRelay?.botUsername || "", key),
    },

    materialByEntry,
    sourceTag,
  };
}

export {
  подобрать,
  персональнаяМетка,
  подставить,
  норма,
  загрузитьСценарии,
  createIgQueue,
  createIgRelayClient,
  подписьВерна,
  подтверждениеПодписки,
  идентификаторыАккаунтов,
  разобратьСобытия,
  createTgStore,
  parseEntry,
  botLink,
  createTexts,
  createTgRelayClient,
  withOutgoingLog,
  createAmoClient,
  createLeadStore,
  createDiagEngine,
  createFollowupEngine,
  createReportBuilder,
  createHeartbeat,
};
