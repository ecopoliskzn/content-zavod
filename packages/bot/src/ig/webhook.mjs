// Разбор вебхука Instagram + проверка подписи. Порт логики app/api/ig/webhook/route.ts
// из исходного проекта, вынесенной из Next.js route-хендлера в обычные функции: маршрутизацию
// (framework, HTTP-ответы) делает приложение-потребитель, этот модуль только разбирает.

import crypto from "node:crypto";

/**
 * Проверка подписи X-Hub-Signature-256. Сравнение — постоянного времени.
 * @param {string} тело сырое тело запроса (ДО любого повторного JSON.stringify)
 * @param {string|null|undefined} заголовок значение заголовка x-hub-signature-256
 * @param {string} секрет IG_MSG_APP_SECRET конкретного инстанса
 */
export function подписьВерна(тело, заголовок, секрет) {
  if (!секрет || !заголовок) return false;
  const ожидаем = "sha256=" + crypto.createHmac("sha256", секрет).update(тело, "utf8").digest("hex");
  const a = Buffer.from(ожидаем);
  const b = Buffer.from(заголовок);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Подтверждение подписки (GET hub.challenge). Вызывающая сторона сама решает, как
 * вернуть значение (text/plain, 200).
 */
export function подтверждениеПодписки({ mode, token, challenge, verifyToken }) {
  if (mode === "subscribe" && verifyToken && token === verifyToken && challenge) {
    return { ok: true, challenge };
  }
  return { ok: false };
}

/**
 * Извлекает список entry.id (аккаунтов IG), по которым приложение с общим вебхуком
 * решает, кому маршрутизировать событие (D-012: один вебхук на несколько инстансов).
 * @param {string} тело сырое тело запроса
 * @returns {string[]}
 */
export function идентификаторыАккаунтов(тело) {
  try {
    const данные = JSON.parse(тело);
    return (данные.entry || []).map((з) => String(з.id || "")).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Разбирает тело вебхука в список нормализованных событий ig-очереди (см. ig/queue.mjs).
 * Опционально фильтрует по entry.id, если инстанс отвечает не за все аккаунты общего
 * приложения (D-012).
 *
 * @param {string} тело сырое тело запроса
 * @param {{ accountId?: string }} [опции] если задан accountId — берутся только entry
 *   с этим id
 * @returns {Array<import("./queue.mjs").СобытиеIG>}
 */
export function разобратьСобытия(тело, опции = {}) {
  const { accountId } = опции;
  const события = [];
  let данные;
  try {
    данные = JSON.parse(тело);
  } catch {
    return события;
  }

  for (const запись of данные.entry || []) {
    if (accountId && String(запись.id) !== String(accountId)) continue;

    for (const и of запись.changes || []) {
      if (и.field !== "comments") continue;
      const v = и.value || {};
      const id = String(v.id || "");
      if (!id) continue;
      const от = v.from || {};
      const медиа = v.media || {};
      события.push({
        id: "com-" + id,
        вид: "комментарий",
        текст: String(v.text || ""),
        отId: String(от.id || ""),
        отИмя: String(от.username || ""),
        когда: new Date((запись.time || Date.now() / 1000) * 1000).toISOString(),
        пост: String(медиа.id || ""),
        принято: new Date().toISOString(),
      });
    }

    for (const м of запись.messaging || []) {
      const сообщение = м.message || {};
      const от = м.sender || {};
      const id = String(сообщение.mid || "");
      // Своё эхо Meta присылает тоже: сообщение, отправленное нами же, приходит
      // обратно с sender = наш аккаунт. Без отсечки движок ответит сам себе.
      if (!id || !сообщение.text || String(от.id) === String(запись.id)) continue;
      события.push({
        id: "msg-" + id,
        вид: "директ",
        текст: String(сообщение.text || ""),
        отId: String(от.id || ""),
        когда: new Date(Number(м.timestamp) || Date.now()).toISOString(),
        принято: new Date().toISOString(),
      });
    }
  }

  return события;
}
