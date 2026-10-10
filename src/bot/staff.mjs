// Рабочая группа: команды команде, рубильник выпуска, кнопки новостей и ручной выкладки.
//
// Всё, что команда клиента делает с заводом, делается из Telegram и с телефона:
// согласовать, поправить, снять, остановить выпуск, взять заявку. Командная строка и
// сервер остаются оператору.

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dataPath, list } from "../lib/env.mjs";
import { h, resolve as resolveAlert, toGroup } from "../lib/notify.mjs";
import { answerCallback, editMessageText, sendMessage } from "../lib/telegram.mjs";
import { STATUS_TITLE, preview } from "../queue/format.mjs";
import { record } from "../queue/ledger.mjs";
import { digest, morning } from "../queue/runner.mjs";
import { all, get, patch } from "../queue/store.mjs";
import { setStatus as setNewsStatus } from "../news/inbox.mjs";

const isApprover = (id) => list("APPROVER_IDS").includes(String(id));
const who = (from) => [from?.first_name, from?.last_name].filter(Boolean).join(" ") || from?.username || String(from?.id || "");

const HELP = [
  "<b>Команды рабочей группы</b>",
  "/plan — что стоит на сегодня и что ждёт согласования",
  "/day — что вышло сегодня",
  "/waiting — всё, что ждёт «да»",
  "/stop_release — остановить выпуск целиком (только утверждающий)",
  "/start_release — снова включить выпуск",
  "",
  "Согласование: кнопки под карточкой. Правка: кнопка «Правка», затем ответ на карточку.",
  "Заявки: кнопка «Взял в работу». Ответ на вопрос из бота: ответом на сообщение с вопросом.",
].join("\n");

/** Команда в группе. Возвращает true, если команда наша. */
export async function handleCommand(message) {
  const text = String(message.text || "");
  const m = text.match(/^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i);
  if (!m) return false;
  const chat = message.chat.id;
  const thread = message.message_thread_id ? { message_thread_id: message.message_thread_id } : {};
  const reply = (t) => sendMessage(chat, t, thread);
  switch (m[1].toLowerCase()) {
    case "help":
    case "start":
      await reply(HELP);
      return true;
    case "plan":
      await reply(morning(all(), Date.now()));
      return true;
    case "day":
      await reply(digest(all(), Date.now()));
      return true;
    case "waiting": {
      const waiting = all().filter((e) => e.status === "review").sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
      await reply(waiting.length ? `<b>Ждут «да»: ${waiting.length}</b>\n${waiting.map((e) => `${e.date.slice(5)} ${e.time} · ${h(e.channel)} · ${h(preview(e, 50))}`).join("\n")}` : "Всё согласовано, ничего не ждёт.");
      return true;
    }
    case "stop_release":
      if (!isApprover(message.from?.id)) { await reply("Остановить выпуск может только утверждающий."); return true; }
      writeFileSync(dataPath("STOP"), `остановил ${who(message.from)} ${new Date().toISOString()}`, "utf8");
      await reply("⏸ Выпуск остановлен. Ничего не выйдет, пока не придёт команда /start_release.");
      return true;
    case "start_release":
      if (!isApprover(message.from?.id)) { await reply("Включить выпуск может только утверждающий."); return true; }
      for (const f of ["STOP", "HOLD"]) if (existsSync(dataPath(f))) rmSync(dataPath(f));
      resolveAlert("release:stop");
      resolveAlert("release:hold");
      await reply("▶️ Выпуск включён. Одобренное пойдёт по расписанию; опоздавшее выйдет по одному, не пачкой.");
      return true;
    default:
      return false;
  }
}

/**
 * Кнопки не про согласование и не про заявки:
 *   r:go               — снять удержание выпуска после простоя сервера;
 *   n:take|skip:<id>   — новость из ящика: в работу или мимо;
 *   d:done:<id>        — пакет на ручную выкладку (Дзен) выложен.
 */
export async function handleCallback(cb) {
  const data = String(cb.data || "");
  if (data === "r:go") {
    // Удержание после простоя сервера снимает утверждающий или сотрудник: это решение
    // «дублей не будет», а не согласование текста.
    if (!isApprover(cb.from?.id) && !list("STAFF_IDS").includes(String(cb.from?.id))) { await answerCallback(cb.id, "Кнопка для сотрудников компании.", true); return true; }
    if (existsSync(dataPath("HOLD"))) rmSync(dataPath("HOLD"));
    resolveAlert("release:hold");
    await answerCallback(cb.id, "Выпуск продолжен.");
    if (cb.message) await editMessageText(cb.message.chat.id, cb.message.message_id, `${h(cb.message.text || "")}\n\n▶️ Продолжил(а) ${h(who(cb.from))}`, { reply_markup: { inline_keyboard: [] } });
    return true;
  }
  const news = data.match(/^n:(take|skip):(.+)$/);
  if (news) {
    const ok = setNewsStatus(news[2], news[1] === "take" ? "taken" : "skipped", who(cb.from));
    await answerCallback(cb.id, ok ? (news[1] === "take" ? "Взято в работу: оператор получит в следующей сессии." : "Мимо.") : "Этой новости уже нет в ящике.");
    if (ok && cb.message) {
      const mark = news[1] === "take" ? `✅ В работу: ${h(who(cb.from))}` : `➖ Мимо: ${h(who(cb.from))}`;
      await editMessageText(cb.message.chat.id, cb.message.message_id, `${h(cb.message.text || "")}\n\n${mark}`, { reply_markup: { inline_keyboard: [] } });
    }
    return true;
  }
  const manual = data.match(/^d:done:([0-9a-f]{16})$/);
  if (manual) {
    const entry = get(manual[1]);
    if (!entry) { await answerCallback(cb.id, "Записи нет в очереди.", true); return true; }
    await patch(entry.id, { result: { ...(entry.result || {}), manual: `выложил(а) ${who(cb.from)}` } }, `tg:${cb.from.id}`);
    record(entry, "published", { link: entry.result?.link || "", by: who(cb.from) });
    await answerCallback(cb.id, "Отмечено как вышедшее. Ссылку можно прислать ответом на это сообщение.");
    if (cb.message) await editMessageText(cb.message.chat.id, cb.message.message_id, `${h(cb.message.text || "")}\n\n✅ Выложил(а) ${h(who(cb.from))}`, { reply_markup: { inline_keyboard: [] } });
    return true;
  }
  return false;
}

/** Ответ со ссылкой на сообщение-пакет: дописываем ссылку к записи ручной выкладки. */
export async function handlePackageReply(message) {
  const replied = message.reply_to_message?.message_id;
  const link = String(message.text || "").match(/https?:\/\/\S+/)?.[0];
  if (!replied || !link) return false;
  const entry = all().find((e) => e.result?.packageMessageId === replied);
  if (!entry) return false;
  await patch(entry.id, { result: { ...(entry.result || {}), link } }, `tg:${message.from?.id}`);
  record(entry, "link", { link });
  await toGroup("packages", `Ссылка записана: ${h(entry.name)} (${STATUS_TITLE[entry.status]}).`);
  return true;
}
