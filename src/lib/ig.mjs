// Вызовы Instagram API (вход через Instagram, хост graph.instagram.com).
//
// С сервера в России graph.instagram.com не отвечает, поэтому вызовы идут через релей за
// границей: он подставляет маркер из заголовка и передаёт запрос как есть. Маркер в
// релее не хранится: он живёт 60 дней и перевыпускается, и лишний шаг «обновить секрет
// релея» однажды обязательно забудут. Данных релей не хранит вовсе.
//
// Без IG_RELAY_URL вызов идёт напрямую: так работает компьютер оператора и второй узел.

import { env } from "./env.mjs";
import { request } from "./http.mjs";

const GRAPH = "https://graph.instagram.com";

/**
 * @param {string} path путь после хоста, без ведущего слеша: "me?fields=user_id,username"
 * @param {{ method?: string, body?: object, timeoutMs?: number, retries?: number }} [opts]
 */
export async function ig(path, { method = "GET", body, timeoutMs = 30_000, retries = 1 } = {}) {
  const token = env("IG_TOKEN");
  if (!token) return { kind: "refused", status: 0, data: null, text: "", error: "нет IG_TOKEN" };
  const relay = env("IG_RELAY_URL");
  const init = { method, timeoutMs, retries, retryDelayMs: 10_000, headers: {} };
  if (body !== undefined) {
    // Контейнеры Graph API принимают параметры формы. JSON остаётся у сообщений:
    // recipient/message там вложенные объекты и имеют другой контракт.
    const endpoint=path.split('?')[0];
    const publishing=method==='POST'&&(endpoint.endsWith('/media')||endpoint.endsWith('/media_publish'));
    init.body = publishing?new URLSearchParams(Object.entries(body).filter(([,v])=>v!==undefined&&v!==null).map(([k,v])=>[k,String(v)])):JSON.stringify(body);
    init.headers["content-type"] = publishing?'application/x-www-form-urlencoded':"application/json";
  }
  if (relay) {
    init.headers["x-relay-secret"] = env("IG_RELAY_SECRET");
    init.headers["x-ig-token"] = token;
    return request(`${relay.replace(/\/+$/, "")}/ig/${path}`, init);
  }
  const sep = path.includes("?") ? "&" : "?";
  return request(`${GRAPH}/${path}${sep}access_token=${encodeURIComponent(token)}`, init);
}

/** Номер аккаунта для адресов вида /<IG_ID>/media. */
export const igUserId = () => env("IG_USER_ID");
