// Журнал исходящих: тот же tg-events.jsonl, что и у входящих (telegram/store.mjs::logEvent) —
// воронка v2, ВОРОНКА-V2, раздел "OUTGOING LOG". Раньше в журнале была только
// половина разговора (входящие от человека): Live Reply Relay (тот же план, раздел "1") без
// исходящих не может показать в теме продавца, что клиенту уже доставлено, а что нет.
//
// Оборачивается ОДИН раз вокруг relay-клиента (createBotInstance, telegram/relay.mjs), а не
// в каждой точке вызова (sales-card.mjs/tg-flow.mjs/followup.mjs) — иначе пришлось бы
// протащить лог во все текущие места отправки и не забыть про каждое новое.
//
// Что логируется: только УСПЕШНЫЕ (res.ok) sendMessage/sendPhoto/copyMessage/editMessageText —
// то, что реально долетело клиенту текстом/фото/копией. answerCallbackQuery и
// editMessageReplyMarkup НЕ логируются: это не переписка с человеком, а служебные ответы на
// нажатия кнопки/снятие клавиатуры. Текст/подпись обрезаются до 500 символов.
//
// Секреты сюда попасть не могут: оборачивается только тело запроса Bot API (chat_id/text/
// caption/…), которое и так уходит наружу самим вызовом, — токен бота живёт в Cloudflare
// Worker'е (apps/bot-instance/workers/tg-relay/worker.js) и relay-секрет остаются внутри
// relay.mjs, сюда не доходят вовсе.
//
// от "человек" — реле живого ответа сотрудника клиенту (Live Reply Relay, раздел "1а",
// apps/bot-instance/src/tg-flow.mjs): вызывающий код передаёт { ..., от: "человек" } ПОСЛЕДНИМ
// аргументом (тем же местом, где обычно доп. поля Bot API вроде parse_mode) — здесь это
// снимается ДО вызова настоящего метода (в Telegram это поле не уходит) и попадает только в
// запись журнала. Без маркера — "бот" (обычные сценарные/служебные отправки).

const ЛОГИРУЕМЫЕ_МЕТОДЫ = ["sendMessage", "sendPhoto", "copyMessage", "editMessageText"];

/** Текст/подпись для журнала — по методу и (уже без служебного "от") аргументам вызова.
 *  Позиция различается: sendMessage(chatId, text, …) — text вторым, а editMessageText
 *  (chatId, messageId, text, buttons, …) и sendPhoto (chatId, fileId, caption, buttons, …) —
 *  третьим (messageId/fileId занимает второй). */
function текстВызова(method, args) {
  if (method === "sendPhoto" || method === "editMessageText") return args[2];
  if (method === "copyMessage") return args[3]?.caption;
  return args[1]; // sendMessage: второй параметр — text
}

/**
 * Оборачивает relay-клиент (telegram/relay.mjs::createTgRelayClient) логом исходящих.
 * Прочие методы (answerCallbackQuery, editMessageReplyMarkup, call/вызвать) остаются как есть.
 * @param {ReturnType<import("./relay.mjs").createTgRelayClient> | null} client
 * @param {{ logEvent: (event: object) => Promise<void> }} store telegram/store.mjs инстанса
 */
export function withOutgoingLog(client, store) {
  if (!client || !store) return client;

  function обернуть(method) {
    const оригинал = client[method];
    if (typeof оригинал !== "function") return оригинал;

    return async (...args) => {
      // Последний аргумент — обычно "доп" (доп. поля Bot API): если в нём есть "от",
      // это наш служебный маркер атрибуции, а не поле для Telegram — снимаем перед вызовом.
      const индексДоп = args.length - 1;
      const допИсходный = args[индексДоп];
      let от = "бот";
      let чистыеАргументы = args;
      if (допИсходный && typeof допИсходный === "object" && !Array.isArray(допИсходный) && "от" in допИсходный) {
        от = допИсходный.от === "человек" ? "человек" : "бот";
        const { от: _пропустить, ...остальное } = допИсходный;
        чистыеАргументы = [...args];
        чистыеАргументы[индексДоп] = остальное;
      }

      const res = await оригинал(...чистыеАргументы);

      if (res?.ok) {
        const messageId = res?.данные?.result?.message_id;
        await store
          .logEvent({
            ушло: {
              чат: String(чистыеАргументы[0] ?? ""),
              текст: String(текстВызова(method, чистыеАргументы) ?? "").slice(0, 500),
              от,
              method,
              messageId,
            },
          })
          .catch(() => {});
      }

      return res;
    };
  }

  const обёрнутый = { ...client };
  for (const method of ЛОГИРУЕМЫЕ_МЕТОДЫ) обёрнутый[method] = обернуть(method);
  return обёрнутый;
}
