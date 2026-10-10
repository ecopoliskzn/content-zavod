// Хранилище подписчиков TG: jsonl-буфер, дозапись, слияние по очереди (queue-safe).
// Порт lib/telegram/store.ts из kormishin-site. Пути к файлам — параметры фабрики
// (не process.env), чтобы разные инстансы бота (leanliga, alyona, …) не делили файл
// и чтобы тесты не трогали общее окружение процесса.
//
// 152-ФЗ: подписчики — ПДн (имя, телефон), первичная запись на VPS в РФ.

import { promises as fs } from "node:fs";
import path from "node:path";

async function ensureDir(file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
}

/**
 * @param {object} конфиг
 * @param {string} конфиг.subsFile путь к jsonl-файлу подписчиков
 * @param {string} конфиг.eventsFile путь к jsonl-файлу сырых апдейтов
 */
export function createTgStore({ subsFile, eventsFile }) {
  if (!subsFile) throw new TypeError("createTgStore: нужен subsFile");
  if (!eventsFile) throw new TypeError("createTgStore: нужен eventsFile");

  /** Читает весь буфер. Последняя запись по id побеждает. */
  async function readSubscribers() {
    let raw = "";
    try {
      raw = await fs.readFile(subsFile, "utf8");
    } catch {
      return [];
    }
    const byId = new Map();
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const rec = JSON.parse(s);
        if (rec?.id) byId.set(String(rec.id), rec);
      } catch {
        // битая строка не должна ронять чтение всего буфера
      }
    }
    return [...byId.values()];
  }

  async function findSubscriber(id) {
    const all = await readSubscribers();
    return all.find((s) => s.id === String(id));
  }

  /** Подписчик по messageId его карточки продавца (Live Reply Relay, BOT-ALYONA-FUNNEL-V2,
   *  раздел "1", направление "тема → клиент"): владелец/Алёна отвечает В ГРУППЕ на
   *  сообщение карточки — Bot API отдаёт только message_id, кому она принадлежит нужно
   *  искать самим. Линейный проход по уже прочитанному буферу — та же цена, что и у
   *  findSubscriber выше (readSubscribers и так читает всё в память на каждый вызов);
   *  отдельного файла-индекса не заводим, т.к. карточка редактируется на месте
   *  (editMessageText) и её messageId не дублируется у живых записей. */
  async function findByCardMessageId(messageId) {
    const all = await readSubscribers();
    const key = String(messageId);
    return all.find((s) => String(s?.salesCard?.messageId ?? "") === key);
  }

  /** Дописывает запись (полное состояние подписчика) в конец буфера. */
  async function writeSubscriber(rec) {
    await ensureDir(subsFile);
    const withTime = { ...rec, updatedAt: new Date().toISOString() };
    await fs.appendFile(subsFile, JSON.stringify(withTime) + "\n", "utf8");
  }

  /* Очередь записей в памяти процесса: без неё два одновременных вызова upsertSubscriber
     читают одно и то же старое состояние, и кто дописал вторым — стирает поле первого
     (потерянное согласие 152-ФЗ было поймано ревью 19.09.2026 в kormishin). */
  let очередь = Promise.resolve();
  function поОчереди(работа) {
    const итог = очередь.then(работа, работа);
    очередь = итог.catch(() => {});
    return итог;
  }

  async function слить(id, patch) {
    const key = String(id);
    const было = await findSubscriber(key);
    const current = было || { id: key, tags: [], status: "active" };
    const merged = {
      ...current,
      ...patch,
      ...(patch.lead ? { lead: { ...patch.lead, at: patch.lead.at ?? new Date().toISOString() } } : {}),
      id: key,
      tags: [...new Set([...(current.tags || []), ...(patch.tags || [])])],
      profile: { ...(current.profile || {}), ...(patch.profile || {}) },
      // funnel: ISO-время ПЕРВОГО наступления шага (воронка v2, BOT-ALYONA-FUNNEL-V2,
      // "Контракт данных") — current.funnel побеждает при конфликте ключа, patch.funnel
      // добавляет только то, чего ещё не было. Порядок спреда: patch первым, current
      // вторым — так уже записанное значение не переписывается более поздним патчем.
      ...(patch.funnel ? { funnel: { ...patch.funnel, ...(current.funnel || {}) } } : {}),
      // salesCard: обычное слияние патча поверх текущего (messageId/status/takenBy/…
      // обновляются по месту, как и profile выше) — карточка продавца, одна на человека.
      ...(patch.salesCard ? { salesCard: { ...(current.salesCard || {}), ...patch.salesCard } } : {}),
    };

    if (!было && !merged.subscribedAt) merged.subscribedAt = new Date().toISOString();

    if (patch.firstName !== undefined || patch.lastName !== undefined) {
      const собрано = [merged.firstName, merged.lastName].filter(Boolean).join(" ").trim();
      if (собрано) merged.name = собрано;
    }

    await writeSubscriber(merged);
    return merged;
  }

  /** Слияние: читает текущее состояние, накладывает патч, дописывает. Строго по очереди. */
  function upsertSubscriber(id, patch) {
    return поОчереди(() => слить(id, patch));
  }

  /** Сырой лог входящих апдейтов. */
  async function logEvent(event) {
    await ensureDir(eventsFile);
    const rec = { at: new Date().toISOString(), event };
    await fs.appendFile(eventsFile, JSON.stringify(rec) + "\n", "utf8");
  }

  /** Метка входа, по которой человек пришёл В ПОСЛЕДНИЙ РАЗ (теги "вход-<метка>"). */
  function последнийВход(sub) {
    const метки = (sub?.tags || []).filter((t) => t.startsWith("вход-"));
    return метки.length ? метки[метки.length - 1].replace("вход-", "") : undefined;
  }

  return {
    readSubscribers,
    findSubscriber,
    findByCardMessageId,
    writeSubscriber,
    upsertSubscriber,
    logEvent,
    последнийВход,
    files: { subsFile, eventsFile },
  };
}
