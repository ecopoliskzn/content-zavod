// Согласование: карточка в рабочей группе Telegram и кнопки под ней.
//
// КТО ГОВОРИТ «ДА». Ответственный со стороны клиента. Его числовой id Telegram лежит в
// APPROVER_IDS; нажатие любого другого участника группы бот вежливо отклоняет. Имя и
// время согласия записываются в запись очереди: если публикацию оспорят, видно, кто и
// какой текст одобрил.
//
// ЧТО ВИДИТ ЧЕЛОВЕК. Текст ровно таким, каким он уйдёт на площадку, слот, из чего
// сделан материал, вердикт проверок и источники цифр. Карточка читается с телефона:
// согласование не должно требовать компьютера.
//
// КНОПКИ:
//   Одобрить — запись встаёт в расписание. Если слот уже прошёл, бот сам ставит её
//              в ближайший свободный и пишет, в какой;
//   Правка   — бот просит ответить на карточку сообщением. Текст ответа уходит оператору;
//   Снять    — запись не выйдет;
//   Отозвать — передумали после «да», пока запись не вышла.
//
// ПРАВКА ТЕКСТА ПОСЛЕ «ДА» СОГЛАСИЕ СНИМАЕТ: запись возвращается в черновики и приходит
// новой карточкой. Человек говорил «да» другому тексту.

import { channel as channelCfg } from "../lib/config.mjs";
import { list } from "../lib/env.mjs";
import { groupId, h, toGroup } from "../lib/notify.mjs";
import { answerCallback, editMessageText, keyboard } from "../lib/telegram.mjs";
import { dueAt, human } from "../lib/time.mjs";
import { check } from "../gates/index.mjs";
import { STATUS_TITLE, preview } from "../queue/format.mjs";
import { nextSlot } from "../queue/slots.mjs";
import { RuleError, all, get, patch, reschedule, transition } from "../queue/store.mjs";

export const approvers = () => list("APPROVER_IDS");
const isApprover = (userId) => approvers().includes(String(userId));
const who = (from) => [from?.first_name, from?.last_name].filter(Boolean).join(" ") || from?.username || String(from?.id || "");

const BUTTONS = (id) => [[{ text: "✅ Одобрить", data: `q:ok:${id}` }, { text: "✏️ Правка", data: `q:fix:${id}` }, { text: "🚫 Снять", data: `q:no:${id}` }]];
const UNDO = (id) => [[{ text: "↩️ Отозвать согласие", data: `q:undo:${id}` }]];

/** Текст карточки: содержимое как на площадке плюс всё, что нужно для решения. */
export function cardText(entry, verdict = { block: [], warn: [] }, footer = "") {
  const cfg = channelCfg(entry.channel);
  const isReply = entry.kind === "reply";
  const rows = isReply
    ? [`<b>На согласование · ответ на комментарий · ${h(cfg.title)}</b>`, entry.context ? `Комментарий: «${h(String(entry.context).slice(0, 600))}»` : ""].filter(Boolean)
    : [`<b>На согласование · ${h(cfg.title)}</b>`, `Слот: ${human(entry)} · материал: ${h(entry.material || "не указан")}`];
  if (cfg.access === "restricted") rows.push("<i>Площадка с ограниченным доступом: только разбор и польза, без цен и призывов купить.</i>");
  rows.push("");
  if (entry.kind === "thread") {
    (entry.posts || []).forEach((p, i) => rows.push(`<b>${i + 1}.</b> ${h(p)}`, ""));
  } else {
    if (entry.title) rows.push(`<b>${h(entry.title)}</b>`, "");
    // Разметку поста не экранируем наполовину: показываем текст как есть, без тегов.
    rows.push(h(String(entry.text || "").replace(/<[^>]+>/g, "")), "");
  }
  for (const m of entry.media || []) rows.push(`${m.type === "video" ? "🎬 Ролик" : "🖼 Картинка"}: ${h(m.url)}`);
  for (const row of entry.buttons || []) for (const b of row) rows.push(`🔘 Кнопка «${h(b.text)}» → ${h(b.url)}`);
  if (entry.link) rows.push(`🔗 Ссылка в тексте ведёт на: ${h(entry.link)}`);
  const facts = (entry.facts || []).filter((f) => f?.claim);
  if (facts.length) {
    rows.push("", "<b>Откуда цифры</b>");
    for (const f of facts.slice(0, 8)) rows.push(`· ${h(f.claim)} — ${h(f.source || "источник не указан")}`);
  }
  rows.push("", verdict.block.length ? `⛔ Проверки не пройдены:\n${h(verdict.block.join("\n"))}` : "✓ Проверки пройдены: готовность, речь, реклама, факты.");
  if (verdict.warn.length) rows.push(`⚠️ На что посмотреть:\n${h(verdict.warn.join("\n"))}`);
  if (footer) rows.push("", footer);
  return rows.join("\n");
}

/**
 * Отправить запись на согласование: проверки, карточка в группу, статус «ждёт согласования».
 * Отказ по правилу (RuleError), если проверки не пройдены: в группу уходит только то,
 * что можно выпускать.
 */
export async function submit(id, by = "оператор") {
  const entry = get(id);
  if (!entry) throw new RuleError(`записи ${id} нет в очереди`);
  if (!["draft", "rework"].includes(entry.status)) throw new RuleError(`запись в статусе «${STATUS_TITLE[entry.status]}», на согласование уходят черновики`);
  const verdict = check(entry);
  if (verdict.block.length) throw new RuleError(`проверки не пройдены:\n- ${verdict.block.join("\n- ")}`);
  const sent = await toGroup("approval", cardText(entry, verdict), { buttons: BUTTONS(entry.id) });
  if (!sent.ok) throw Object.assign(new Error(`карточка не ушла в группу: ${sent.error}`), { code: "ENV" });
  return transition(entry.id, "review", { approval: { card: { messageId: sent.messageId }, sentAt: new Date().toISOString() }, note: undefined, nudged: false, fixAsked: undefined }, by);
}

async function redraw(entry, footer, buttons) {
  const messageId = entry.approval?.card?.messageId;
  if (!messageId) return;
  const res = await editMessageText(groupId(), messageId, cardText(entry, check(entry), footer).slice(0, 4000), buttons ? keyboard(buttons) : { reply_markup: { inline_keyboard: [] } });
  // Длинная ветка уходила несколькими сообщениями: кнопки висят на последнем, правим только его шапку.
  if (res.kind !== "ok" && !/message is not modified/i.test(res.error || "")) {
    await editMessageText(groupId(), messageId, footer || "Карточка обновлена.", buttons ? keyboard(buttons) : { reply_markup: { inline_keyboard: [] } });
  }
}

/**
 * Нажатие кнопки под карточкой. Возвращает true, если нажатие наше (q:…).
 * @param {{ id: string, data: string, from: object, message?: object }} cb
 */
export async function handleCallback(cb) {
  const m = String(cb.data || "").match(/^q:(ok|fix|no|undo|next):([0-9a-f]{16})$/);
  if (!m) return false;
  const [, action, id] = m;
  if (!isApprover(cb.from?.id)) {
    await answerCallback(cb.id, "Согласует ответственный со стороны компании. Если это вы, попросите оператора добавить ваш номер.", true);
    return true;
  }
  const entry = get(id);
  if (!entry) { await answerCallback(cb.id, "Этой записи уже нет в очереди.", true); return true; }
  const name = who(cb.from);
  const actor = `tg:${cb.from.id}`;

  try {
    if (action === "ok") {
      if (entry.status !== "review") { await answerCallback(cb.id, `Запись сейчас «${STATUS_TITLE[entry.status]}».`, true); return true; }
      const verdict = check(entry);
      if (verdict.block.length) { await answerCallback(cb.id, `Проверка не пускает: ${verdict.block[0].slice(0, 150)}`, true); return true; }
      let moved = "";
      if (entry.kind !== "reply" && dueAt(entry) < Date.now() + 15 * 60_000) {
        const slot = nextSlot(channelCfg(entry.channel), all().filter((e) => e.channel === entry.channel), Date.now(), entry.id);
        if (slot) { await reschedule(entry.id, slot.date, slot.time, actor); moved = " Прежний слот прошёл, поставил в ближайший свободный."; }
      }
      const approved = await transition(entry.id, "approved", { approval: { ...(entry.approval || {}), by: cb.from.id, name, at: new Date().toISOString() }, fixAsked: undefined }, actor);
      await answerCallback(cb.id, "Одобрено.");
      await redraw(approved, entry.kind === "reply" ? `✅ Одобрил(а) ${h(name)}. Текст ответа придёт в тему «Выложить руками» в течение пяти минут.` : `✅ Одобрил(а) ${h(name)}. Выйдет ${human(approved)}.${moved}`, UNDO(entry.id));
    } else if (action === "fix") {
      if (!["review", "approved"].includes(entry.status)) { await answerCallback(cb.id, `Запись сейчас «${STATUS_TITLE[entry.status]}».`, true); return true; }
      await patch(entry.id, { fixAsked: { by: cb.from.id, name, at: new Date().toISOString() } }, actor);
      await answerCallback(cb.id, "Ответьте на эту карточку сообщением: что поправить.", true);
    } else if (action === "no") {
      if (["published", "cancelled", "running"].includes(entry.status)) { await answerCallback(cb.id, `Запись уже «${STATUS_TITLE[entry.status]}».`, true); return true; }
      const cancelled = await transition(entry.id, "cancelled", { note: `снял(а) ${name}` }, actor);
      await answerCallback(cb.id, "Снято.");
      await redraw(cancelled, `🚫 Снял(а) ${h(name)}. Не выйдет.`, null);
    } else if (action === "undo") {
      if (entry.status !== "approved") { await answerCallback(cb.id, `Отозвать уже нельзя: запись «${STATUS_TITLE[entry.status]}».`, true); return true; }
      const back = await transition(entry.id, "review", { approval: { card: entry.approval?.card }, note: `согласие отозвал(а) ${name}` }, actor);
      await answerCallback(cb.id, "Согласие отозвано.");
      await redraw(back, `↩️ Согласие отозвал(а) ${h(name)}. Запись снова ждёт решения.`, BUTTONS(entry.id));
    } else if (action === "next") {
      if (!["expired", "failed"].includes(entry.status)) { await answerCallback(cb.id, `Запись сейчас «${STATUS_TITLE[entry.status]}».`, true); return true; }
      const slot = nextSlot(channelCfg(entry.channel), all().filter((e) => e.channel === entry.channel), Date.now(), entry.id);
      if (!slot) { await answerCallback(cb.id, "Свободных слотов на месяц вперёд нет.", true); return true; }
      const moved = await reschedule(entry.id, slot.date, slot.time, actor);
      await answerCallback(cb.id, `Поставил на ${human(moved)}.`, true);
    }
  } catch (e) {
    await answerCallback(cb.id, e.code === "RULE" ? e.message.slice(0, 180) : "Не получилось, оператор уже видит ошибку.", true);
    if (e.code !== "RULE") console.error("[approval] сбой обработки кнопки", e);
  }
  return true;
}

/**
 * Ответ на карточку текстом: правка от утверждающего. Возвращает true, если это она.
 * @param {{ text?: string, from: object, reply_to_message?: { message_id: number } }} message
 */
export async function handleReply(message) {
  const replied = message.reply_to_message?.message_id;
  if (!replied || !message.text) return false;
  const entry = all().find((e) => e.approval?.card?.messageId === replied);
  if (!entry) return false;
  if (!isApprover(message.from?.id)) return true; // обсуждение под карточкой правкой не считаем
  if (!["review", "approved"].includes(entry.status)) return true;
  const name = who(message.from);
  const actor = `tg:${message.from.id}`;
  let current = entry;
  if (entry.status === "approved") current = await transition(entry.id, "review", { approval: { card: entry.approval?.card } }, actor);
  const rework = await transition(current.id, "rework", { note: message.text.slice(0, 1500), fixAsked: undefined, reworkBy: name }, actor);
  await redraw(rework, `✏️ На правке. ${h(name)}: «${h(message.text.slice(0, 300))}»\nВернётся новой карточкой.`, null);
  return true;
}

/** Что ждёт оператора: записи на правке с текстом замечания. */
export function inbox() {
  return all().filter((e) => e.status === "rework").map((e) => ({ id: e.id, channel: e.channel, name: e.name, note: e.note || "", by: e.reworkBy || "", preview: preview(e) }));
}
