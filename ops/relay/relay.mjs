// Релей: посредник за границей между сервером завода в России и площадками, до которых
// из России напрямую не дотянуться (Telegram Bot API, Instagram Graph API).
//
// Один файл на две среды: Cloudflare Workers (worker.mjs) и обычный Node на маленьком
// сервере в Нидерландах (node-server.mjs). Логика одна, отличается только обвязка.
//
// ЧТО ДЕЛАЕТ.
//   POST /tg/webhook          Telegram присылает сюда обновления бота → передаём серверу завода;
//   POST /api/<метод>         сервер завода зовёт Bot API → передаём в Telegram;
//   POST /upload/<метод>      то же с файлом (фото, видео): тело уходит потоком, как пришло;
//   ANY  /ig/<путь>           сервер завода зовёт Instagram API → передаём, подставив маркер;
//   GET/HEAD /media/<hash>.jpg только уже открытая публикационная JPEG-версия с origin;
//   GET  /health              жив ли релей.
//
// ЧТО НЕ ДЕЛАЕТ. Ничего не хранит и ничего не пишет в журнал, кроме кода ответа. Через
// релей проходят сообщения людей боту, поэтому он обязан оставаться трубой: ни базы, ни
// файлов, ни текста сообщений в журналах. Персональные данные записываются только на
// сервере в России.
//
// ГДЕ ЛЕЖАТ СЕКРЕТЫ. Токен бота живёт только здесь (на сервере завода его нет вовсе).
// Маркер Instagram здесь НЕ хранится: он живёт 60 дней и перевыпускается, сервер присылает
// его в заголовке каждого вызова. Иначе при каждом продлении пришлось бы обновлять секрет
// релея, и однажды это забыли бы.
//
// Переменные релея: TG_BOT_TOKEN, TG_RELAY_SECRET, TG_WEBHOOK_SECRET, IG_RELAY_SECRET,
// ORIGIN_URL (адрес сервера завода с https://).

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** Сравнение секретов без утечки по времени ответа. */
function same(a, b) {
  const x = new TextEncoder().encode(String(a || ""));
  const y = new TextEncoder().encode(String(b || ""));
  if (!x.length || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Ответ площадки возвращаем как есть: код и тело. Заголовки берём только безопасные. */
async function passthrough(res) {
  return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") || "application/json" } });
}

/**
 * @param {Request} request
 * @param {Record<string,string>} env
 * @param {typeof fetch} [doFetch] подмена сети для тестов
 */
export async function handle(request, env, doFetch = fetch) {
  const url = new URL(request.url);
  const p = url.pathname;

  if (request.method === "GET" && p === "/health") return json(200, { ok: true, relay: "ecopolis-zavod" });

  // Только ранее открытые origin-файлы: не медиатека, не backup и не произвольный URL.
  // Поток не кэшируется и не сохраняется. Секреты и cookie посетителя не пересылаются.
  if (p.startsWith('/media/')) {
    if (!['GET','HEAD'].includes(request.method) || url.search || !/^\/media\/[a-f0-9]{64}\.jpg$/.test(p)) return new Response(null,{status:404});
    try {
      const origin = new URL(env.ORIGIN_URL);
      if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return new Response(null,{status:502});
      const res = await doFetch(origin.origin+p,{method:request.method,headers:{accept:'image/jpeg'},redirect:'error',signal:AbortSignal.timeout(20000)});
      if (res.status===404) return new Response(null,{status:404});
      const type=(res.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
      const length=Number(res.headers.get('content-length'));
      if (res.status!==200 || type!=='image/jpeg' || !Number.isFinite(length) || length<=0 || length>8*1024*1024) {await res.body?.cancel();return new Response(null,{status:502});}
      return new Response(request.method==='HEAD'?null:res.body,{status:200,headers:{'content-type':'image/jpeg','content-length':String(length),'cache-control':'no-store','x-content-type-options':'nosniff'}});
    } catch {return new Response(null,{status:502});}
  }

  // ── Telegram → сервер завода ──
  if (request.method === "POST" && p === "/tg/webhook") {
    const secret = request.headers.get("x-telegram-bot-api-secret-token");
    if (!same(secret, env.TG_WEBHOOK_SECRET)) return json(401, { ok: false });
    if (!env.ORIGIN_URL) return json(500, { ok: false, error: "нет ORIGIN_URL" });
    try {
      const res = await doFetch(`${env.ORIGIN_URL.replace(/\/+$/, "")}/tg/update`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
        body: await request.text(),
        signal: AbortSignal.timeout(20_000),
      });
      // Сервер ответил ошибкой или недоступен: отдаём Telegram не-200, он повторит позже.
      return json(res.ok ? 200 : 502, { ok: res.ok });
    } catch {
      return json(502, { ok: false });
    }
  }

  // ── сервер завода → Telegram ──
  const tg = p.match(/^\/(api|upload)\/([A-Za-z]{3,40})$/);
  if (request.method === "POST" && tg) {
    if (!same(request.headers.get("x-relay-secret"), env.TG_RELAY_SECRET)) return json(401, { ok: false, description: "секрет релея не подошёл" });
    if (!env.TG_BOT_TOKEN) return json(500, { ok: false, description: "в релее нет токена бота" });
    const target = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${tg[2]}`;
    try {
      const init = tg[1] === "upload"
        // Файл не читаем в память: тело идёт потоком вместе с границей multipart из заголовка.
        ? { method: "POST", headers: { "content-type": request.headers.get("content-type") || "" }, body: request.body, duplex: "half" }
        : { method: "POST", headers: { "content-type": "application/json" }, body: await request.text() };
      return passthrough(await doFetch(target, init));
    } catch (e) {
      return json(502, { ok: false, description: `Telegram недоступен из релея: ${e?.message || e}` });
    }
  }

  // ── сервер завода → Instagram ──
  if (p.startsWith("/ig/")) {
    if (!same(request.headers.get("x-relay-secret"), env.IG_RELAY_SECRET || env.TG_RELAY_SECRET)) return json(401, { error: { message: "секрет релея не подошёл" } });
    const token = request.headers.get("x-ig-token");
    if (!token) return json(400, { error: { message: "нет маркера в заголовке x-ig-token" } });
    const path = p.slice(4);
    if (!/^[\w.\-/]+$/.test(path)) return json(400, { error: { message: "недопустимый путь" } });
    const target = new URL(`https://graph.instagram.com/${path}`);
    for (const [k, v] of url.searchParams) target.searchParams.set(k, v);
    target.searchParams.set("access_token", token);
    try {
      const hasBody = !["GET", "HEAD"].includes(request.method);
      return passthrough(await doFetch(target.toString(), { method: request.method, headers: hasBody ? { "content-type": request.headers.get("content-type") || "application/json" } : {}, body: hasBody ? await request.text() : undefined }));
    } catch (e) {
      return json(502, { error: { message: `Instagram недоступен из релея: ${e?.message || e}` } });
    }
  }

  return json(404, { ok: false });
}
