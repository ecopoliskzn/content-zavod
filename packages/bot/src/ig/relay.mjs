// Клиент для workers/ig-relay (kormishin-site): релей проксирует наши вызовы к
// graph.instagram.com, потому что с VPS в РФ Instagram напрямую недоступен.
// URL воркера и токены — из конфига инстанса, не хардкод.

/**
 * @param {object} конфиг
 * @param {string} конфиг.url базовый адрес ig-relay, например https://ig-relay.example.workers.dev
 * @param {string} конфиг.relaySecret значение заголовка x-relay-secret
 * @param {string} конфиг.igToken долгоживущий маркер IG (access token), заголовок x-ig-token
 */
export function createIgRelayClient({ url, relaySecret, igToken }) {
  if (!url) throw new TypeError("createIgRelayClient: нужен url релея");

  /** Низкоуровневый вызов Graph API через релей. path без ведущего /ig/. */
  async function вызвать(путь, { method = "GET", body } = {}) {
    const цель = new URL(`${url.replace(/\/+$/, "")}/ig/${путь}`);
    const опции = {
      method,
      headers: {
        "x-relay-secret": relaySecret || "",
        "x-ig-token": igToken || "",
      },
    };
    if (body !== undefined) {
      опции.body = typeof body === "string" ? body : JSON.stringify(body);
      опции.headers["content-type"] = "application/json";
    }
    const ответ = await fetch(цель.toString(), опции);
    const данные = await ответ.json().catch(() => ({}));
    return { ok: ответ.ok, status: ответ.status, данные };
  }

  /** Отправка сообщения в директ конкретному IGSID. */
  async function отправитьДирект(igsid, текст, доп = {}) {
    return вызвать("me/messages", {
      method: "POST",
      body: {
        recipient: { id: igsid },
        message: { text: текст },
        ...доп,
      },
    });
  }

  return { вызвать, отправитьДирект };
}
