// Объектное хранилище по протоколу S3: подпись запроса (AWS Signature V4) и загрузка файла.
//
// Без библиотек: нужен один вызов PUT, а зависимость пришлось бы обновлять и проверять.
// Подходит любое S3-совместимое хранилище в России: Timeweb Cloud S3, Yandex Object
// Storage. Адрес, регион и ключи задаются окружением, код от поставщика не зависит.
//
// ЗАЧЕМ ХРАНИЛИЩЕ. Instagram, Threads и Rutube не принимают файл от нас: они забирают
// его сами по публичному адресу. С сайта клиента и с сервера завода Meta файл не берёт,
// из публичного объектного хранилища берёт. Какое именно хранилище Meta видит, проверяется
// живым вызовом в первой сессии (npm run doctor -- --media).

import { createHash, createHmac } from "node:crypto";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** Кодирование по RFC 3986: encodeURIComponent оставляет ! * ' ( ) как есть, S3 требует закодировать. */
export const rfc3986 = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Путь объекта: каждый кусок кодируется, слеши остаются. */
export const encodeKey = (key) => String(key).split("/").map(rfc3986).join("/");

/**
 * Подпись запроса. Чистая функция: одинаковый вход даёт одинаковый заголовок.
 * @param {{ method: string, url: string, headers: Record<string,string>, payloadHash: string, accessKey: string, secretKey: string, region: string, service?: string, now?: Date }} p
 * @returns {Record<string,string>} заголовки запроса вместе с authorization
 */
export function signV4({ method, url, headers = {}, payloadHash, accessKey, secretKey, region, service = "s3", now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")])), host: u.host, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash };
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${all[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...u.searchParams.entries()].map(([k, v]) => [rfc3986(k), rfc3986(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = [method.toUpperCase(), u.pathname, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

/**
 * Загрузка объекта одним запросом PUT.
 * @param {{ endpoint: string, bucket: string, key: string, body: Buffer, contentType: string, accessKey: string, secretKey: string, region: string, acl?: string, cacheControl?: string, timeoutMs?: number }} p
 * @returns {Promise<{ ok: boolean, status: number, error: string }>}
 */
export async function putObject({ endpoint, bucket, key, body, contentType, accessKey, secretKey, region, acl, cacheControl, timeoutMs = 20 * 60_000 }) {
  const url = `${endpoint.replace(/\/+$/, "")}/${bucket}/${encodeKey(key)}`;
  const headers = signV4({
    method: "PUT",
    url,
    headers: { "content-type": contentType, ...(acl ? { "x-amz-acl": acl } : {}), ...(cacheControl ? { "cache-control": cacheControl } : {}) },
    payloadHash: sha256(body),
    accessKey,
    secretKey,
    region,
  });
  delete headers.host; // хост fetch подставит сам, свой заголовок он не принимает
  try {
    const res = await fetch(url, { method: "PUT", headers: { ...headers, "content-length": String(body.length) }, body, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return { ok: true, status: res.status, error: "" };
    const text = await res.text();
    return { ok: false, status: res.status, error: (text.match(/<Message>([^<]+)</)?.[1] || text.slice(0, 200) || `HTTP ${res.status}`).trim() };
  } catch (e) {
    return { ok: false, status: 0, error: `сеть: ${e?.cause?.code || e?.name || e?.message || e}` };
  }
}
