// Рабочая группа: команды команде, рубильник выпуска, кнопки новостей и ручной выкладки.
//
// Всё, что команда клиента делает с заводом, делается из Telegram и с телефона:
// согласовать, поправить, снять, остановить выпуск, взять заявку. Командная строка и
// сервер остаются оператору.

import { list } from "../lib/env.mjs";
import { h, resolve as resolveAlert, toGroup } from "../lib/notify.mjs";
import { answerCallback, editMessageText, sendMessage } from "../lib/telegram.mjs";
import { STATUS_TITLE, preview } from "../queue/format.mjs";
import { record } from "../queue/ledger.mjs";
import { digest, morning } from "../queue/runner.mjs";
import { all, get, patch, transition } from "../queue/store.mjs";
import { clearHold, clearStop, isHeld, isRestored, runnerBusy, setStop, stopState } from "../queue/switch.mjs";
import { setStatus as setNewsStatus } from "../news/inbox.mjs";
import { setStatus as setCommentStatus } from "../comments/collect.mjs";
import { sayAll, syncAll } from "../video/schedule.mjs";

/** Сроки роликов YouTube после рубильника: что снято, что поставлено, что не получилось. */
async function youtubeAfterSwitch() {
  try { return sayAll(await syncAll()); } catch (e) {
    console.error("[staff] сверка сроков YouTube не прошла:", e?.message || e);
    return "Сроки роликов YouTube сверить не удалось: сервер повторит попытку через пять минут.";
  }
}

const TAKEOVER_NOTE = "Расписание сейчас ведёт компьютер оператора: сервер остановлен на время аварии. Включит его оператор, когда вернёт серверу вышедшее. Команда /start_release сейчас дала бы двух выпускающих и задвоенные посты.";
const RESTORED_NOTE = "Расписание в архиве старше настоящего: что вышло и что сняли после архива, сервер не знает. Выпуск начнётся, когда оператор сверит сервер с копией расписания. Кнопка «Продолжить выпуск» до этого не действует.";
// Компьютер оператора спрашивает сервер перед каждым проходом, раз в пять минут.
const TAKEOVER_LAG = "Расписание сейчас ведёт компьютер оператора. О вашей команде он узнаёт при сверке с сервером, в пределах пяти минут: запись, чей слот наступает прямо сейчас, ещё может выйти.";

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
    case "plan": {
      // Состояние рубильников стоит первой строкой: «почему ничего не выходит» — самый
      // частый вопрос, и ответ на него должен быть виден с телефона.
      const stop = stopState();
      const state = isRestored()
        ? `🧯 <b>Сервер восстановлен из архива.</b> ${RESTORED_NOTE}\n\n`
        : stop.human && stop.takeover
        ? "⏸ <b>Выпуск остановлен.</b> Включает команда /start_release. Расписание при этом перехвачено компьютером оператора: после команды выпуск продолжит он.\n\n"
        : stop.takeover
          ? `⏸ <b>Выпуск на сервере остановлен.</b> ${TAKEOVER_NOTE}\n\n`
          : stop.stopped
            ? "⏸ <b>Выпуск остановлен.</b> Включает команда /start_release.\n\n"
            : isHeld()
              ? "⏳ <b>Выпуск ждёт кнопки «Продолжить выпуск»</b>: сервер вернулся после простоя.\n\n"
              : "";
      await reply(state + morning(all(), Date.now()));
      return true;
    }
    case "day":
      await reply(digest(all(), Date.now()));
      return true;
    case "waiting": {
      const waiting = all().filter((e) => e.status === "review").sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
      await reply(waiting.length ? `<b>Ждут «да»: ${waiting.length}</b>\n${waiting.map((e) => `${e.date.slice(5)} ${e.time} · ${h(e.channel)} · ${h(preview(e, 50))}`).join("\n")}` : "Всё согласовано, ничего не ждёт.");
      return true;
    }
    case "stop_release": {
      if (!isApprover(message.from?.id)) { await reply("Остановить выпуск может только утверждающий."); return true; }
      /* Слово человека ставится всегда, и при перехвате тоже. Раньше команда отвечала
         «выпуск уже остановлен» и ничего не ставила, а компьютер оператора продолжал
         выпускать: человек сказал «стоп» и получил обратное. */
      const taken = setStop({ by: who(message.from), reason: "команда /stop_release" }).takeover;
      // Ролики YouTube с датой выхода сервер не выпускает: их открывает сам YouTube.
      // Поэтому остановка снимает с них срок, и «ничего не выйдет» говорится по результату.
      const yt = await youtubeAfterSwitch();
      // Отправку, которая идёт в эту самую минуту, оборвать нельзя: говорим об этом, а не обещаем «ничего».
      const inFlight = runnerBusy() ? " Запись, отправка которой уже началась, довыйдет; следующую сервер не возьмёт." : "";
      const said = taken ? `${TAKEOVER_LAG} Включает выпуск команда /start_release.` : `Сервер ничего не выпустит, пока не придёт команда /start_release.${inFlight}`;
      await reply(`⏸ Выпуск остановлен. ${said}${yt ? `\n\n${h(yt)}` : ""}`);
      return true;
    }
    case "start_release": {
      if (!isApprover(message.from?.id)) { await reply("Включить выпуск может только утверждающий."); return true; }
      // Остановку ради перехвата снимает только возврат расписания серверу. Команда
      // снимает слово человека, и только его.
      const was = stopState();
      if (was.takeover && !was.human) { await reply(`Включить выпуск сейчас нельзя. ${TAKEOVER_NOTE}`); return true; }
      const now = clearStop();
      clearHold();
      resolveAlert("release:stop");
      resolveAlert("release:hold");
      const yt = await youtubeAfterSwitch();
      const said = now.takeover
        ? "▶️ Остановка снята. Расписание всё ещё ведёт компьютер оператора: выпуск продолжит он, после ближайшей сверки с сервером. На сервере выпуск включит оператор, когда вернёт ему вышедшее."
        : isRestored()
          ? `▶️ Остановка снята, но выпуск пока стоит. ${RESTORED_NOTE}`
          : "▶️ Выпуск включён. Одобренное пойдёт по расписанию; опоздавшее выйдет по одному, не пачкой.";
      await reply(`${said}${yt ? `\n\n${h(yt)}` : ""}`);
      return true;
    }
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
    // Расписание ведёт компьютер оператора: кнопка под старым сообщением не должна
    // включить второго выпускающего.
    if (stopState().takeover) { await answerCallback(cb.id, "Расписание сейчас ведёт компьютер оператора. Выпуск на сервере включит оператор.", true); return true; }
    // Сервер из архива: расписание в нём старше настоящего. Кнопка задвоила бы вышедшее.
    if (isRestored()) { await answerCallback(cb.id, "Сервер восстановлен из архива: сначала оператор сверяет его с копией расписания. Кнопка до этого не действует.", true); return true; }
    clearHold();
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
    // «Вышло» запись становится здесь, а не в минуту отправки пакета: до нажатия кнопки
    // материал на площадке не появился, и в сводке дня он стоит отдельной строкой.
    if (entry.status === "published") { await answerCallback(cb.id, "Уже отмечено как вышедшее."); return true; }
    if (entry.status !== "handed") { await answerCallback(cb.id, `Запись сейчас «${STATUS_TITLE[entry.status] || entry.status}»: отмечать нечего.`, true); return true; }
    const at = new Date().toISOString();
    await transition(entry.id, "published", { result: { ...(entry.result || {}), manual: `выложил(а) ${who(cb.from)}` }, publishedAt: at }, "рабочая группа");
    if (entry.kind === "reply") {
      // Ответ на комментарий — не публикация по сетке: в журнале у него свой статус, а
      // сам комментарий помечается отвеченным.
      record(entry, "replied", { link: entry.link || "", by: who(cb.from) });
      const commentId = String(entry.material || "").replace(/^comment:/, "");
      if (commentId) setCommentStatus(commentId, "answered", who(cb.from));
    } else {
      record(entry, "published", { link: entry.result?.link || "", by: who(cb.from) });
    }
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
  await patch(entry.id, { result: { ...(entry.result || {}), link } }, "рабочая группа");
  record(entry, "link", { link });
  // Ссылку прислали, а кнопку не нажали: без отметки «Выложено» запись так и останется
  // переданной, и в отчёт публикация не попадёт.
  const pending = entry.status === "handed" ? " Нажмите «Выложено» под пакетом: без отметки публикация не попадёт в отчёт." : "";
  await toGroup("packages", `Ссылка записана: ${h(entry.name)} (${STATUS_TITLE[entry.status]}).${pending}`);
  return true;
}
