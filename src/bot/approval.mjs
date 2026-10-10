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
// РОЛИК YOUTUBE С ДАТОЙ ВЫХОДА. Он загружен закрытым, и YouTube откроет его сам, что бы ни
// стало с записью. Поэтому «Снять», «Отозвать» и правка сразу снимают срок на YouTube, а
// человеку пишется, что получилось: «не выйдет» говорится только по ответу YouTube.
// Подробно: src/video/schedule.mjs.
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
import { slotFor } from "../queue/slots.mjs";
import { RuleError, all, get, patch, reschedule, transition } from "../queue/store.mjs";
import { stopState } from "../queue/switch.mjs";
import { afterChange as syncYoutube } from "../video/schedule.mjs";

/*
 * ПЕРЕХВАТ РАСПИСАНИЯ. Пока расписание ведёт компьютер оператора, кнопки по-прежнему
 * обрабатывает сервер, а выпускает не он. Решение человека доходит до компьютера при
 * сверке раз в пять минут, а новое «да» не доходит вовсе: компьютер выпускает только
 * одобренное до аварии. Отвечать при этом «Не выйдет» и «Выйдет в 14:30» было бы
 * неправдой, поэтому в ответ дописывается, как обстоит дело.
 */
const lagNote = (wasApproved) => (wasApproved && stopState().takeover ? " Расписание сейчас ведёт компьютер оператора: о вашем решении он узнаёт при сверке с сервером, в пределах пяти минут. Если слот записи в эти минуты, она ещё может выйти." : "");
const waitNote = () => (stopState().takeover ? " Расписание сейчас ведёт компьютер оператора, и новые согласия он не принимает: запись выйдет, когда расписание вернётся серверу." : "");

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
  // У ролика под согласованным текстом программа сама ставит ссылки и хэштеги. Человек
  // должен видеть и их: «да» относится ко всему, что появится под роликом.
  const isVideo = ["video", "short"].includes(entry.kind);
  if (isVideo) {
    const under = [
      entry.goSlug ? `ссылка на материал «${entry.goSlug}»` : "",
      entry.botKey ? `ссылка в бота на материал «${entry.botKey}»` : "",
      entry.article ? `ссылка на статью «${entry.article}»` : "",
      entry.series ? `серия «${entry.series}» и соседние ролики` : "",
      entry.hashtags?.length ? `хэштеги: ${entry.hashtags.map((t) => `#${String(t).replace(/^#/, "")}`).join(" ")}` : "",
    ].filter(Boolean);
    if (under.length) rows.push("", `<b>Под текстом программа поставит</b>\n${under.map((u) => `· ${h(u)}`).join("\n")}`);
  }
  // Вопрос автора утверждающему: спорное место решает человек клиента, а не программа.
  if (entry.ask) rows.push("", `❓ <b>Вопрос к вам:</b> ${h(String(entry.ask).slice(0, 500))}`);
  const facts = (entry.facts || []).filter((f) => f?.claim);
  if (facts.length) {
    rows.push("", "<b>Откуда цифры</b>");
    for (const f of facts.slice(0, 8)) rows.push(`· ${h(f.claim)} — ${h(f.source || "источник не указан")}`);
  }
  rows.push("", verdict.block.length ? `⛔ Проверки не пройдены:\n${h(verdict.block.join("\n"))}` : `✓ Проверки пройдены: готовность, речь, реклама, факты${isVideo || entry.kind === "reel" ? ", ролик" : ""}.`);
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
        const slot = slotFor(entry, all(), channelCfg(entry.channel));
        if (slot) { await reschedule(entry.id, slot.date, slot.time, actor); moved = " Прежний слот прошёл, поставил в ближайший свободный."; }
      }
      const approved = await transition(entry.id, "approved", { approval: { ...(entry.approval || {}), by: cb.from.id, name, at: new Date().toISOString() }, fixAsked: undefined }, actor);
      await answerCallback(cb.id, "Одобрено.");
      // Ролик, загруженный до «да», лежит на YouTube без срока: срок ставится сейчас.
      const yt = await syncYoutube(entry.id);
      const tail = yt ? `\n${h(yt)}` : "";
      // Ролик YouTube открывает сам YouTube по сроку, который ставит сервер: перехват его не задерживает.
      const wait = entry.channel === "youtube" ? "" : waitNote();
      const said = wait
        ? `✅ Одобрил(а) ${h(name)}.${wait}`
        : entry.kind === "reply" ? `✅ Одобрил(а) ${h(name)}. Текст ответа придёт в тему «Выложить руками» в течение пяти минут.` : `✅ Одобрил(а) ${h(name)}. Выйдет ${human(approved)}.${moved}`;
      await redraw(approved, `${said}${entry.kind === "reply" ? "" : tail}`, UNDO(entry.id));
    } else if (action === "fix") {
      if (!["review", "approved"].includes(entry.status)) { await answerCallback(cb.id, `Запись сейчас «${STATUS_TITLE[entry.status]}».`, true); return true; }
      await patch(entry.id, { fixAsked: { by: cb.from.id, name, at: new Date().toISOString() } }, actor);
      await answerCallback(cb.id, "Ответьте на эту карточку сообщением: что поправить.", true);
    } else if (action === "no") {
      if (["published", "cancelled", "running"].includes(entry.status)) { await answerCallback(cb.id, `Запись уже «${STATUS_TITLE[entry.status]}».`, true); return true; }
      const cancelled = await transition(entry.id, "cancelled", { note: `снял(а) ${name}` }, actor);
      await answerCallback(cb.id, "Снято.");
      // «Не выйдет» про ролик с датой выхода говорится только по ответу YouTube.
      const yt = await syncYoutube(entry.id);
      // Пакет уже у сотрудника: программа выложенное не снимет, об этом и говорим.
      // При перехвате «Не выйдет» не говорится: о снятии компьютер оператора узнаёт не сразу.
      const lag = lagNote(entry.status === "approved");
      const said = entry.status === "handed" ? "Пакет в теме «Выложить руками» больше не действует. Если материал уже выложен, его убирает владелец аккаунта." : yt ? h(yt) : lag ? "" : "Не выйдет.";
      await redraw(cancelled, `🚫 Снял(а) ${h(name)}.${said ? ` ${said}` : ""}${lag}`, null);
    } else if (action === "undo") {
      if (entry.status !== "approved") { await answerCallback(cb.id, `Отозвать уже нельзя: запись «${STATUS_TITLE[entry.status]}».`, true); return true; }
      const back = await transition(entry.id, "review", { approval: { card: entry.approval?.card }, note: `согласие отозвал(а) ${name}` }, actor);
      await answerCallback(cb.id, "Согласие отозвано.");
      const yt = await syncYoutube(entry.id);
      const tail = yt ? `\n${h(yt)}` : "";
      await redraw(back, `↩️ Согласие отозвал(а) ${h(name)}. Запись снова ждёт решения.${lagNote(true)}${tail}`, BUTTONS(entry.id));
    } else if (action === "next") {
      if (!["expired", "failed"].includes(entry.status)) { await answerCallback(cb.id, `Запись сейчас «${STATUS_TITLE[entry.status]}».`, true); return true; }
      const slot = slotFor(entry, all(), channelCfg(entry.channel));
      if (!slot) { await answerCallback(cb.id, "Свободных слотов на два месяца вперёд нет.", true); return true; }
      const moved = await reschedule(entry.id, slot.date, slot.time, actor);
      await answerCallback(cb.id, `Поставил на ${human(moved)}.`, true);
      await syncYoutube(entry.id);
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
  const yt = await syncYoutube(entry.id);
  const tail = yt ? `\n${h(yt)}` : "";
  await redraw(rework, `✏️ На правке. ${h(name)}: «${h(message.text.slice(0, 300))}»\nВернётся новой карточкой.${lagNote(entry.status === "approved")}${tail}`, null);
  return true;
}

/** Что ждёт оператора: записи на правке с текстом замечания. */
export function inbox() {
  return all().filter((e) => e.status === "rework").map((e) => ({ id: e.id, channel: e.channel, name: e.name, note: e.note || "", by: e.reworkBy || "", preview: preview(e) }));
}
