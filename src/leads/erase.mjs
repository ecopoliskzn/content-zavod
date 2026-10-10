#!/usr/bin/env node
// Удаление персональных данных человека: по отзыву согласия или по его требованию.
//
// Человек вправе отозвать согласие, и тогда оператор обязан прекратить обработку и
// уничтожить данные (в срок до 30 дней, если нет иного законного основания их хранить).
// В боте это одна команда /stop, и удаление происходит сразу.
//
// ПОЧЕМУ ФАЙЛЫ ПЕРЕПИСЫВАЮТСЯ. Журналы завода только дописываются: «последняя строка
// побеждает». Для данных человека этого мало: новая строка без телефона оставляет
// телефон в старой строке. Поэтому здесь журналы переписываются целиком, без строк
// этого человека. Это единственное место, где так можно.
//
// ЧТО ОСТАЁТСЯ. Журнал согласий: номер пользователя, вид согласия, время выдачи и
// отзыва. Это доказательство того, что согласие было и когда оно отозвано; имени и
// телефона в нём нет. И строка в журнале удалений: когда и по какому основанию удалено.
//
//   node src/leads/erase.mjs --user=<номер пользователя Telegram>
//   node src/leads/erase.mjs --lead=<номер заявки>          заявка с формы, где бота не было
//   node src/leads/erase.mjs --phone=<телефон>              найти и удалить по телефону
//   …с флагом --dry только показывает, сколько строк будет удалено.
//
// Сообщения в рабочей группе Telegram скрипт удалить не может (бот не удаляет сообщения
// старше 48 часов). Карточка заявки переписывается на «согласие отозвано», а переписку с
// человеком за пределами бота сотрудник удаляет сам: об этом он получает сообщение.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dataPath } from "../lib/env.mjs";
import { appendJsonl, readJsonl, writeAtomic } from "../lib/files.mjs";

const digits = (s) => String(s || "").replace(/\D/g, "").replace(/^8(?=\d{10}$)/, "7");

/**
 * Какие строки принадлежат человеку. Чистая функция: журналы на вход, отбор на выход.
 * @param {{ user?: string, lead?: string, phone?: string }} who
 */
export function select(who, { leads = [], cards = [], subscribers = [], events = [], relay = [] }) {
  const phone = who.phone ? digits(who.phone) : "";
  const leadIds = new Set();
  const users = new Set(who.user ? [String(who.user)] : []);
  for (const l of leads) {
    const mine = (who.lead && String(l.id) === String(who.lead)) || (who.user && String(l.tgUserId) === String(who.user)) || (phone && digits(l.phone) === phone);
    if (!mine) continue;
    leadIds.add(String(l.id));
    if (l.tgUserId) users.add(String(l.tgUserId));
  }
  for (const c of cards) {
    if ((phone && digits(c.phone) === phone) || (c.tgUserId && users.has(String(c.tgUserId)))) leadIds.add(String(c.leadId));
  }
  for (const s of subscribers) if (phone && digits(s.phone) === phone) users.add(String(s.id));
  return {
    leadIds,
    users,
    keep: {
      leads: leads.filter((l) => !leadIds.has(String(l.id)) && !users.has(String(l.tgUserId))),
      cards: cards.filter((c) => !leadIds.has(String(c.leadId)) && !users.has(String(c.tgUserId))),
      subscribers: subscribers.filter((s) => !users.has(String(s.id))),
      events: events.filter((e) => !users.has(String(e.event?.from))),
      relay: relay.filter((r) => !users.has(String(r.tgUserId))),
    },
  };
}

const FILES = () => ({
  leads: dataPath("leads", "leads.jsonl"),
  cards: dataPath("leads", "lead-cards.jsonl"),
  subscribers: dataPath("leads", "tg-subscribers.jsonl"),
  events: dataPath("leads", "tg-events.jsonl"),
  relay: dataPath("leads", "relay.jsonl"),
});

/**
 * Удаляет данные человека из журналов завода.
 * @returns {{ removed: number, leadIds: string[], users: string[], cards: object[] }} cards — карточки до удаления (чтобы переписать сообщения в группе)
 */
export function erase(who, { dry = false, reason = "отзыв согласия" } = {}) {
  const files = FILES();
  const before = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, readJsonl(f)]));
  const picked = select(who, before);
  let removed = 0;
  for (const [k, f] of Object.entries(files)) {
    removed += before[k].length - picked.keep[k].length;
    if (!dry && existsSync(f) && before[k].length !== picked.keep[k].length) writeAtomic(f, picked.keep[k].map((r) => JSON.stringify(r)).join("\n") + (picked.keep[k].length ? "\n" : ""));
  }
  // Последнее состояние карточек: по ним бот перепишет сообщения в рабочей группе.
  const cardState = new Map();
  for (const c of before.cards) if (picked.leadIds.has(String(c.leadId))) cardState.set(c.leadId, { ...(cardState.get(c.leadId) || {}), ...c });
  if (!dry && removed) appendJsonl(dataPath("leads", "erasure.jsonl"), { at: new Date().toISOString(), reason, leads: picked.leadIds.size, users: picked.users.size, rows: removed });
  // Имя и телефон из карточек наружу не отдаём: только номер сообщения и номер заявки.
  return { removed, leadIds: [...picked.leadIds], users: [...picked.users], cards: [...cardState.values()].map((c) => ({ leadId: c.leadId, messageId: c.messageId || null, needTitle: c.needTitle || "", createdAt: c.createdAt || "" })) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const opt = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").slice(name.length + 3);
  const who = { user: opt("user"), lead: opt("lead"), phone: opt("phone") };
  if (!who.user && !who.lead && !who.phone) {
    console.error("кого удалить: --user=<номер Telegram> | --lead=<номер заявки> | --phone=<телефон> [--dry]");
    process.exitCode = 1;
  } else {
    const dry = process.argv.includes("--dry");
    const r = erase(who, { dry, reason: opt("reason") || "требование субъекта данных" });
    console.log(`${dry ? "будет удалено" : "удалено"} строк: ${r.removed}; заявок ${r.leadIds.length}, записей бота ${r.users.length}`);
    if (!dry && r.cards.length) console.log("карточки этих заявок в рабочей группе перепишите руками или удалите: бот перерисовывает их только при отзыве согласия командой /stop");
    if (!r.removed) process.exitCode = 1;
  }
}
