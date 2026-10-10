// Клиент для workers/tg-relay (kormishin-site): релей проксирует Bot API, потому что
// с VPS в РФ api.telegram.org недоступен напрямую. URL и секрет — из конфига инстанса.

/**
 * @param {object} конфиг
 * @param {string} конфиг.url базовый адрес tg-relay, например https://tg-relay.example.workers.dev
 * @param {string} конфиг.relaySecret значение заголовка x-relay-secret (к /api/*)
 * @param {number} [конфиг.timeoutMs] таймаут одного вызова релея (по умолчанию 10с) —
 *   релей (Cloudflare Worker) наблюдал скачки латентности до ~8с (BUG-041), без таймаута
 *   зависший вызов держит квиз/карточку продавца неопределённо долго.
 * @param {(method: string, status: number, description: string) => void} [конфиг.logger]
 *   логгер сбоев вызова (по умолчанию console.error) — метод/статус/описание, НИКОГДА
 *   токен/секрет и НИКОГДА текст сообщения (call() его в лог не передаёт вовсе).
 */
export function createTgRelayClient({ url, relaySecret, timeoutMs = 10_000, logger = console.error }) {
  if (!url) throw new TypeError("createTgRelayClient: нужен url релея");

  /** Подстраховка для лога: description от Telegram короткий, но на случай, если
   *  когда-нибудь туда попадёт что-то длинное — не тащить это в лог целиком. */
  function обрезать(s, n = 200) {
    const строка = String(s ?? "");
    return строка.length > n ? `${строка.slice(0, n)}…` : строка;
  }

  /** Низкоуровневый вызов ЛЮБОГО метода Bot API через релей, например "sendMessage"
   *  или "answerCallbackQuery" — релей (workers/tg-relay) проксирует метод как есть,
   *  этот клиент ничего не ограничивает списком известных методов (LL-инлайн-кнопки).
   *  НИКОГДА не бросает исключение (BUG-041: квиз/карточка продавца делали на голом
   *  fetch без таймаута — при зависшем релее .catch(() => ({ok:false})) вызывающего
   *  кода не срабатывал, потому что fetch просто висел). Сетевой сбой/таймаут релея
   *  сведены к тому же {ok:false} виду, что и обычный неуспешный ответ Telegram, плюс
   *  retryable:true — для сбоев, где имеет смысл повторить (таймаут/сеть/5xx). */
  async function call(method, body) {
    const controller = new AbortController();
    const таймер = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let ответ;
      try {
        ответ = await fetch(`${url.replace(/\/+$/, "")}/api/${method}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-relay-secret": relaySecret || "",
          },
          body: JSON.stringify(body ?? {}),
          signal: controller.signal,
        });
      } catch (e) {
        const description = controller.signal.aborted ? "timeout" : e instanceof Error ? e.message : String(e);
        logger?.(method, 0, description);
        return { ok: false, status: 0, данные: { description }, retryable: true };
      }

      const данные = await ответ.json().catch(() => ({}));
      const ok = ответ.ok && данные.ok !== false;
      const retryable = !ok && ответ.status >= 500;
      if (!ok) logger?.(method, ответ.status, обрезать(данные.description));
      return { ok, status: ответ.status, данные, retryable };
    } finally {
      clearTimeout(таймер);
    }
  }

  /** Отправка сообщения конкретному chat_id. `доп` может нести reply_markup
   *  (inline_keyboard/keyboard/remove_keyboard) — см. tg-flow.mjs инстансов. */
  async function sendMessage(chatId, text, доп = {}) {
    return call("sendMessage", { chat_id: chatId, text, ...доп });
  }

  /** Отправка фото по Telegram file_id с подписью и (опционально) инлайн-кнопками —
   *  материал статьи (hero/talk), см. tg-flow.mjs::принятьСогласие/предложитьЗаявку.
   *  file_id не секрет и не привязан к конкретному чату — грузится один раз ботом,
   *  дальше переиспользуется без повторной загрузки файла. Пятый параметр — доп. поля
   *  Bot API поверх подписи (например `parse_mode: "HTML"` для ритма подписей, owner 2026-09-28).
   */
  async function sendPhoto(chatId, fileId, caption, buttons, доп = {}) {
    const кнопки = buttons ? { reply_markup: { inline_keyboard: buttons } } : {};
    return call("sendPhoto", { chat_id: chatId, photo: fileId, caption, ...кнопки, ...доп });
  }

  /** Гасит "часики" на нажатой инлайн-кнопке — без этого кнопка выглядит зависшей
   *  секунд двадцать (порт lib/telegram/api.ts::answerCallback из kormishin-site). */
  async function answerCallbackQuery(callbackQueryId, доп = {}) {
    return call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...доп });
  }

  /** Убирает инлайн-клавиатуру у уже отправленного сообщения — защита от двойного
   *  нажатия (порт lib/telegram/api.ts::dropKeyboard). */
  async function editMessageReplyMarkup(chatId, messageId, replyMarkup = { inline_keyboard: [] }) {
    return call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
  }

  /** Редактирует текст уже отправленного сообщения на месте (карточка продавца
   *  «одна на человека», квиз «одно сообщение» — воронка v2, BOT-ALYONA-FUNNEL-V2).
   *  `buttons` — тот же формат инлайн-кнопок, что и у sendMessage/sendPhoto (массив
   *  рядов), `доп` — доп. поля Bot API поверх (например `parse_mode: "HTML"`). */
  async function editMessageText(chatId, messageId, text, buttons, доп = {}) {
    const кнопки = buttons ? { reply_markup: { inline_keyboard: buttons } } : {};
    return call("editMessageText", { chat_id: chatId, message_id: messageId, text, ...кнопки, ...доп });
  }

  /** Копия чужого сообщения (текст, фото, голосовое, файл — что угодно) в другой чат,
   *  без пометки «переслано». Live Reply Relay (воронка v2, BOT-ALYONA-FUNNEL-V2, раздел
   *  "1") использует её в обе стороны: ответ продавца клиенту и свободное сообщение
   *  клиента в тему продавца. `доп` может нести caption (переопределяет подпись при
   *  копировании медиа — своя пометка вместо/поверх исходной), parse_mode,
   *  reply_parameters (ответ на конкретное сообщение — карточку) и message_thread_id
   *  (тема форума), тем же порядком, что и у sendMessage/sendPhoto/editMessageText. */
  async function copyMessage(toChatId, fromChatId, messageId, доп = {}) {
    return call("copyMessage", { chat_id: toChatId, from_chat_id: fromChatId, message_id: messageId, ...доп });
  }

  // "вызвать" — прежнее имя низкоуровневого вызова, оставлено как алиас ради обратной
  // совместимости (на случай, если инстанс уже успел на него завязаться).
  return {
    call,
    вызвать: call,
    sendMessage,
    sendPhoto,
    answerCallbackQuery,
    editMessageReplyMarkup,
    editMessageText,
    copyMessage,
  };
}
