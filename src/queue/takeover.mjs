// Перехват расписания: сверка компьютера оператора с сервером перед каждым проходом.
//
// При перехвате компьютер выпускает по копии очереди. Копия стареет с минуты, когда снята:
// утверждающий мог снять запись, отозвать согласие либо остановить выпуск командой, и
// компьютер об этом не знает. Если сервер при этом отвечает (перехват бывает и при живом
// сервере: встало расписание, а не машина), молчать о его решениях нельзя. Бот отвечал бы
// человеку «Не выйдет», а компьютер выпускал бы запись по своей копии.
//
// Поэтому перед каждым проходом компьютер спрашивает сервер и принимает от него:
//   · человек остановил выпуск → компьютер останавливается тоже, а после /start_release
//     продолжает сам;
//   · сервер вернулся после простоя без отметки перехвата → отметка ставится сразу, иначе
//     выпускали бы обе машины;
//   · согласия на записи больше нет (снята, ждёт «да», на правке) → запись не выходит;
//   · запись исправили и одобрили заново → в копии прежний текст, с компьютера он не выходит;
//   · запись вышла на сервере либо ушла там пакетом → здесь она закрывается;
//   · запись со слотом до перехвата: сервер её не трогал → возвращается в расписание.
//     Так «проверьте площадку глазами» остаётся только на случай, когда сервер лежит;
//   · сервер начал запись и не закончил (ошибка, оборванный проход) → запись придержана
//     до взгляда человека, а вышедшие части ветки переносятся в копию.
// Новые согласования при перехвате не принимаются: компьютер выпускает только то, что
// было одобрено до аварии. Одобренное во время перехвата выйдет после возврата.
//
// Сервер не ответил — компьютер идёт по копии. Это и есть слепое окно перехвата.

import { STATUS_TITLE } from "./format.mjs";
import { server } from "./remote.mjs";
import { all, forceHeld, forcePublished, patch, transition } from "./store.mjs";
import { clearStop, setStop, stopState } from "./switch.mjs";

/** Кто придержал запись со слотом до перехвата и кто правит копию по ответу сервера. */
export const HELD_BY = "перехват";
export const SYNC_BY = "сверка с сервером";

/** Причина местной остановки, принятой с сервера: по ней остановка и снимается сама. */
export const ADOPTED_STOP = "выпуск остановлен человеком на сервере";

/** Причина, с которой перехват ставит остановку серверу. */
export const TAKEOVER_REASON = "перехват расписания компьютером оператора";

/** Причина местной остановки на время возврата расписания серверу. */
export const HANDBACK_STOP = "расписание возвращается серверу";

const NO_CONSENT = ["cancelled", "review", "rework", "draft"];
// «Просрочена» сюда не входит: сервер к такой записи не притрагивался, а правило шести
// часов компьютер применит сам.
const UNFINISHED = ["running", "failed"];

/** Запись придержана перехватом: её слот наступил до него либо сервер её не закончил. */
export const isHeldEntry = (e) => e.status === "failed" && Boolean(e.takeoverHold);

/** Поля, с которыми запись придерживается. Чистая функция: её же зовёт сам перехват. */
export const holdFields = (note) => ({ status: "failed", takeoverHold: true, note });

/**
 * Принять с сервера то, что изменилось после копии.
 * @returns {Promise<{ reached: boolean, stopped?: boolean, resumed?: boolean, paused?: boolean, busy?: boolean, withdrawn?: string[], edited?: string[], released?: string[], confirmed?: string[], held?: string[] }>}
 */
export async function adoptServerState() {
  const r = await server("pulse", {}, 10_000);
  if (r.code !== 0 || !r.data?.statuses) return { reached: false };
  const out = { reached: true, stopped: false, resumed: false, paused: false, busy: Boolean(r.data.busy), withdrawn: [], edited: [], released: [], confirmed: [], held: [] };
  const remoteStop = r.data.stop || {};

  // Слово человека: «стоп» принимается, «старт» тоже. Местную остановку, поставленную
  // оператором на этом компьютере, сервер не снимает.
  const mine = stopState();
  if (remoteStop.human && !mine.human) {
    setStop({ by: remoteStop.by || "", reason: ADOPTED_STOP });
    out.stopped = true;
  } else if (!remoteStop.human && mine.human && mine.reason === ADOPTED_STOP) {
    clearStop();
    out.resumed = true;
  }

  /* Сервер вернулся и о перехвате не знает: без отметки он начнёт выпускать сам. Посреди
     возврата отметку не ставим: возврат как раз её снял, а файл перехвата на компьютере
     мог ещё не исчезнуть (команда оборвалась на последнем шаге). */
  if (!remoteStop.takeover && mine.reason !== HANDBACK_STOP) {
    const paused = await server("pause", { reason: TAKEOVER_REASON, takeover: true, ongoing: true }, 10_000);
    out.paused = paused.code === 0;
  }

  for (const e of all()) {
    const remote = r.data.statuses[e.id];
    if (!remote) continue;
    const held = isHeldEntry(e);
    if (e.status !== "approved" && !held) continue;
    const progress = r.data.progress?.[e.id] || null;

    if (NO_CONSENT.includes(remote)) {
      await transition(e.id, "cancelled", { takeoverHold: undefined, note: `на сервере запись «${STATUS_TITLE[remote] || remote}»: согласие снято после копии` }, SYNC_BY);
      out.withdrawn.push(e.name);
    } else if (remote === "published" || remote === "handed") {
      // Сервер успел выпустить её сам. В местный журнал строка не пишется: это не выход с компьютера.
      await forcePublished(e.id, { takeoverHold: undefined, note: remote === "handed" ? "пакет ушёл сотруднику с сервера до перехвата" : "вышла на сервере до перехвата" }, SYNC_BY);
      out.confirmed.push(e.name);
    } else if (UNFINISHED.includes(remote)) {
      /* Сервер запись начал и не закончил. Что из неё уже на площадке, знает только он и
         сама площадка: с компьютера её выпускает человек, посмотрев глазами. */
      if (!held) {
        await forceHeld(e.id, { ...holdFields(`на сервере запись «${STATUS_TITLE[remote] || remote}»: сервер начал её и не закончил. Проверьте площадку глазами`), ...(progress ? { done: progress.done, result: progress.result || e.result } : {}) }, HELD_BY);
        out.held.push(e.name);
      }
    } else if (remote === "approved") {
      /* На сервере запись одобрена, но текст в ней уже другой: после копии её вернули на
         правку, исправили и одобрили заново. В копии лежит текст, которому сказали «нет».
         С компьютера такая запись не выходит: новый текст выпустит сервер после возврата. */
      const remoteHash = r.data.hashes?.[e.id];
      if (remoteHash && e.contentHash && remoteHash !== e.contentHash) {
        await transition(e.id, "cancelled", { takeoverHold: undefined, note: "на сервере одобрен другой текст этой записи: в копии лежит прежний. Новый выйдет после возврата расписания" }, SYNC_BY);
        out.edited.push(e.name);
        continue;
      }
      // Вышедшие на сервере части ветки переносятся всегда: без них повтор задвоит начало.
      const ahead = progress && (progress.done?.length ?? 0) > (e.done?.length ?? 0);
      if (held && !out.busy) {
        await transition(e.id, "approved", {
          takeoverHold: undefined,
          note: "сервер подтвердил: до перехвата запись не выходила",
          attempts: progress?.attempts ?? 0,
          ...(progress ? { done: progress.done, result: progress.result || e.result } : {}),
        }, SYNC_BY);
        out.released.push(e.name);
      } else if (!held && ahead) {
        await patch(e.id, { done: progress.done, result: progress.result || e.result, attempts: Math.max(e.attempts ?? 0, progress.attempts ?? 0, 1) }, SYNC_BY);
      }
    }
  }
  return out;
}

/** Одна строка в журнал прохода о том, что принято с сервера. Пустая, если нечего сказать. */
export function sayAdopted(seen) {
  if (!seen?.reached) return "";
  const parts = [];
  if (seen.stopped) parts.push("выпуск остановлен человеком");
  if (seen.resumed) parts.push("остановка человеком снята, выпуск продолжается");
  if (seen.paused) parts.push("сервер вернулся без отметки перехвата: отметка поставлена");
  if (seen.withdrawn.length) parts.push(`согласие снято: ${seen.withdrawn.join(", ")}`);
  if (seen.edited.length) parts.push(`на сервере одобрен другой текст, с компьютера не выйдет: ${seen.edited.join(", ")}`);
  if (seen.confirmed.length) parts.push(`вышло на сервере до перехвата: ${seen.confirmed.join(", ")}`);
  if (seen.released.length) parts.push(`возвращено в расписание: ${seen.released.join(", ")}`);
  if (seen.held.length) parts.push(`придержано, сервер начал и не закончил: ${seen.held.join(", ")}`);
  return parts.join("; ");
}
