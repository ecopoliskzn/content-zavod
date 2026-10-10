// Заявки: карточка в рабочую группу, кнопки менеджера, вопросы из бота.
//
// Одна заявка — одна карточка в теме «Заявки». В ней всё, что нужно менеджеру, чтобы
// написать человеку: что просил, откуда пришёл, какой материал читал, как связаться.
// Карточка обновляется на месте (телефон дописался, менеджер взял в работу), а не
// плодит новые сообщения.
//
// СРОК ОТВЕТА. Заявка без «Взял в работу» дольше срока попадает в общую сводку сторожа
// (src/leads/sla.mjs). Одна сводка на все просроченные, а не сообщение на каждую.
//
// Вопрос свободным текстом бот не обсуждает: он передаёт его в группу, а ответ человека
// из команды (ответом на это сообщение) возвращает спросившему. Сочинять ответы на живые
// вопросы автоматом нельзя: десять ответов, написанных конвейером, читаются как конвейер.

import { dataPath, list } from "../lib/env.mjs";
import { appendJsonl, readJsonl } from "../lib/files.mjs";
import { groupId, h, toGroup } from "../lib/notify.mjs";
import { answerCallback, editMessageText, keyboard, sendMessage } from "../lib/telegram.mjs";
import { erase } from "../leads/erase.mjs";

const CARDS = () => dataPath("leads", "lead-cards.jsonl");
const RELAY = () => dataPath("leads", "relay.jsonl");

const who = (from) => [from?.first_name, from?.last_name].filter(Boolean).join(" ") || from?.username || String(from?.id || "");
const isStaff = (userId) => [...list("STAFF_IDS"), ...list("APPROVER_IDS")].includes(String(userId));

/** Последнее состояние карточки по номеру заявки. */
function cards() {
  const map = new Map();
  for (const r of readJsonl(CARDS())) map.set(r.leadId, { ...(map.get(r.leadId) || {}), ...r });
  return map;
}

/** Текст карточки заявки. Чистая функция. */
export function leadCardText(card) {
  const rows = [`🆕 <b>Заявка · ${h(card.needTitle || "без уточнения")}</b>`];
  rows.push(`Кто: ${h(card.name || "имя не указано")}${card.username ? ` · @${h(card.username)}` : ""}`);
  rows.push(card.phone ? `Телефон: ${h(card.phone)}` : "Телефон: не оставлен, связь через Telegram");
  rows.push(`Откуда: ${h(card.sourceLabel || card.source || "не определено")}`);
  if (card.material) rows.push(`Читал(а): ${h(card.material)}`);
  if (card.comment) rows.push(`Написал(а): «${h(String(card.comment).slice(0, 400))}»`);
  rows.push(`Получена: ${h(String(card.createdAt || "").replace("T", " ").slice(0, 16))} UTC`);
  if (card.status === "taken") rows.push("", `✅ В работе: ${h(card.takenBy || "")}`);
  if (card.status === "rejected") rows.push("", `🚫 Не целевая: ${h(card.takenBy || "")}`);
  return rows.join("\n");
}

function cardButtons(card) {
  const rows = [];
  if (card.tgUserId) rows.push([{ text: "Написать в Telegram", url: card.username ? `https://t.me/${card.username}` : `tg://user?id=${card.tgUserId}` }]);
  if (!card.status || card.status === "new") rows.push([{ text: "Взял в работу", data: `l:take:${card.leadId}` }, { text: "Не целевая", data: `l:rej:${card.leadId}` }]);
  return rows;
}

/** Новая заявка: карточка в тему «Заявки». Заявка к этому моменту уже записана на сервере. */
export async function announceLead(lead, sub = {}) {
  const card = {
    leadId: lead.id, tgUserId: lead.tgUserId, name: lead.name, username: lead.username, phone: sub.phone || lead.phone || "",
    needTitle: lead.needTitle, source: lead.source, sourceLabel: lead.sourceLabel, material: lead.material, comment: lead.comment || "", createdAt: lead.createdAt, status: "new",
  };
  const sent = await toGroup("leads", leadCardText(card), { buttons: cardButtons(card) });
  appendJsonl(CARDS(), { ...card, messageId: sent.messageId || null, at: new Date().toISOString(), notified: sent.ok });
  return sent;
}

async function redraw(card) {
  if (!card.messageId) return;
  await editMessageText(groupId(), card.messageId, leadCardText(card), keyboard(cardButtons(card)));
}

/** Дописать в карточку то, что пришло позже (телефон, комментарий). */
export async function updateLeadCard(tgUserId, fields) {
  const mine = [...cards().values()].filter((c) => String(c.tgUserId) === String(tgUserId)).pop();
  if (!mine) return;
  const next = { ...mine, ...fields };
  appendJsonl(CARDS(), { leadId: mine.leadId, ...fields, at: new Date().toISOString() });
  await redraw(next);
}

/** Кнопки менеджера под карточкой. Возвращает true, если нажатие наше (l:…). */
export async function handleCallback(cb) {
  const m = String(cb.data || "").match(/^l:(take|rej):(.+)$/);
  if (!m) return false;
  if (!isStaff(cb.from?.id)) { await answerCallback(cb.id, "Кнопки для сотрудников компании.", true); return true; }
  const card = cards().get(m[2]);
  if (!card) { await answerCallback(cb.id, "Заявка не найдена.", true); return true; }
  if (card.status && card.status !== "new") { await answerCallback(cb.id, `Уже отмечено: ${card.takenBy || ""}`, true); return true; }
  const fields = { status: m[1] === "take" ? "taken" : "rejected", takenBy: who(cb.from), takenAt: new Date().toISOString() };
  appendJsonl(CARDS(), { leadId: card.leadId, ...fields, at: fields.takenAt });
  await answerCallback(cb.id, m[1] === "take" ? "Заявка за вами." : "Отмечено.");
  await redraw({ ...card, ...fields });
  return true;
}

/** Вопрос человека свободным текстом → в группу. Ответ на это сообщение вернётся ему. */
export async function relayQuestion(message, sub = {}) {
  const from = message.from || {};
  // Имя и аккаунт человека в группу не передаются: согласия на обработку он ещё не давал,
  // а чтобы ответить, они не нужны. Ответ уходит через бота.
  const origin = { ig: "Instagram", vk: "ВКонтакте", th: "Threads", yt: "YouTube", rt: "Rutube", dz: "Дзен", tg: "Telegram-канал", site: "сайт" }[sub.entryOrigin] || "";
  const text = `💬 <b>Вопрос из бота</b>${origin ? ` · человек пришёл из ${h(origin)}` : ""}${sub.lastMaterial ? ` · читал материал «${h(sub.lastMaterial)}»` : ""}\n\n«${h(String(message.text || "").slice(0, 1500))}»\n\n<i>Ответьте на это сообщение: бот передаст ответ человеку.</i>`;
  const sent = await toGroup("leads", text);
  if (sent.ok) appendJsonl(RELAY(), { at: new Date().toISOString(), messageId: sent.messageId, tgUserId: String(from.id) });
  return sent;
}

/** Ответ сотрудника в группе на вопрос или карточку → человеку в бот. true, если это он. */
export async function handleGroupReply(message) {
  const replied = message.reply_to_message?.message_id;
  if (!replied || !message.text || message.text.startsWith("/")) return false;
  const viaRelay = readJsonl(RELAY()).find((r) => r.messageId === replied);
  const viaCard = [...cards().values()].find((c) => c.messageId === replied);
  const userId = viaRelay?.tgUserId || viaCard?.tgUserId;
  if (!userId) return false;
  if (!isStaff(message.from?.id)) return true;
  const res = await sendMessage(userId, h(message.text));
  await toGroup("leads", res.kind === "ok" ? "↪️ Ответ передан человеку в бот." : `Ответ не доставлен: ${h(res.error || "")}. Человек мог остановить бота.`, { extra: { reply_parameters: { message_id: message.message_id } } });
  return true;
}

/**
 * Отзыв согласия: данные человека удаляются с сервера, карточка заявки в группе
 * очищается, сотрудники получают просьбу удалить контакты у себя.
 */
export async function withdraw(tgUserId, how = "/stop") {
  const r = erase({ user: String(tgUserId) }, { reason: `отзыв согласия (${how})` });
  for (const c of r.cards) {
    if (!c.messageId) continue;
    await editMessageText(groupId(), c.messageId, `⛔ <b>Согласие отозвано</b>\nЗаявка «${h(c.needTitle || "без уточнения")}» от ${h(String(c.createdAt || "").slice(0, 10))}.\nДанные человека удалены. Не связываться.`, { reply_markup: { inline_keyboard: [] } });
  }
  if (r.cards.length) await toGroup("leads", "Человек отозвал согласие на обработку персональных данных. Карточка его заявки очищена.\n\nЕсли вы записали его телефон или заметки у себя (телефонная книга, CRM, таблица), удалите их: обработка должна прекратиться.");
  return r;
}

/** Заявки, которые никто не взял: для сторожа срока ответа. */
export function openLeads() {
  return [...cards().values()].filter((c) => !c.status || c.status === "new");
}
