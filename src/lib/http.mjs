// Сетевой запрос с тремя исходами: ответила, отказала, не дозвонились.
//
// ЗАЧЕМ ТРИ. «Площадка отказала» и «не смог спросить» требуют разных действий.
// Сторож, который по сетевому сбою объявляет ключ мёртвым, за неделю приучает
// не читать тревоги (у нас первый же прогон отправил девять сообщений подряд).
//   kind: "ok"       — 2xx, тело разобрано;
//   kind: "refused"  — площадка ответила отказом (4xx или 200 с полем error);
//   kind: "network"  — таймаут, обрыв, 5xx, 429: спрашивать ещё раз, ключ не трогать.
//
// Каждому запросу свой срок. Процесс, стартовавший перед сном компьютера, просыпается
// с мёртвым сокетом и без срока висит часами (у нас сбор так провисел 2 ч 50 мин).

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number, retries?: number, retryDelayMs?: number }} [opts]
 * @returns {Promise<{ kind: "ok"|"refused"|"network", status: number, data: any, text: string, error: string }>}
 */
export async function request(url, opts = {}) {
  const { timeoutMs = 30_000, retries = 0, retryDelayMs = 15_000, ...init } = opts;
  let last = { kind: "network", status: 0, data: null, text: "", error: "не начат" };
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs);
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* не JSON — оставляем текст */ }
      const apiError = data && typeof data === "object" && (data.error || data.ok === false);
      if (res.ok && !apiError) return { kind: "ok", status: res.status, data, text, error: "" };
      const message = describe(data) || text.slice(0, 300) || `HTTP ${res.status}`;
      // 5xx и 429 — временное: повторяем, ключ не виноват.
      const temporary = res.status >= 500 || res.status === 429;
      last = { kind: temporary ? "network" : "refused", status: res.status, data, text, error: message };
      if (!temporary) return last;
    } catch (e) {
      const cause = e?.cause?.code || e?.name || "";
      last = { kind: "network", status: 0, data: null, text: "", error: `сеть: ${cause || e?.message || e}` };
    }
  }
  return last;
}

/** Достаёт человеческую причину из типовых ответов площадок. */
function describe(data) {
  if (!data || typeof data !== "object") return "";
  const e = data.error;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    // Meta: {error:{message,code,error_subcode}} · VK: {error:{error_msg,error_code}} · Google: {error:{message,code}}
    const msg = e.message || e.error_msg || e.error_user_msg || "";
    const code = e.code ?? e.error_code ?? "";
    return `${msg}${code !== "" ? ` (код ${code})` : ""}`.trim();
  }
  if (data.ok === false) return `${data.description || "отказ"}${data.error_code ? ` (код ${data.error_code})` : ""}`;
  return "";
}

/** POST формой: Threads и VK принимают параметры формой, JSON там молча теряется. */
export function form(body) {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]))),
  };
}

/** POST JSON. */
export function json(body, headers = {}) {
  return { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}
