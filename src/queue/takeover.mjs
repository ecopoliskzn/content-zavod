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

import { dataPath } from "../lib/env.mjs";
import { readJson, writeJson } from "../lib/files.mjs";
import { STATUS_TITLE } from "./format.mjs";
import { server } from "./remote.mjs";
import { all, forceHeld, forcePublished, patch, transition } from "./store.mjs";
import { ADOPTED_STOP, clearStop, setStop, stopState } from "./switch.mjs";

export { ADOPTED_STOP };

/** Кто придержал запись со слотом до перехвата и кто правит копию по ответу сервера. */
export const HELD_BY = "перехват";
export const SYNC_BY = "сверка с сервером";

/** Причина, с которой перехват ставит остановку серверу. */
export const TAKEOVER_REASON = "перехват расписания компьютером оператора";

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
 * @returns {Promise<{ reached: boolean, stopped?: boolean, resumed?: boolean, paused?: boolean, unguarded?: boolean, busy?: boolean, withdrawn?: string[], edited?: string[], released?: string[], confirmed?: string[], held?: string[] }>}
 *   unguarded — сервер жив, а отметки перехвата на нём нет: выпускать в этом проходе нельзя
 */
export async function adoptServerState() {
  const r = await server("pulse", {}, 10_000);
  if (r.code !== 0 || !r.data?.statuses) return { reached: false };
  const out = { reached: true, stopped: false, resumed: false, paused: false, unguarded: false, staleServer: false, busy: Boolean(r.data.busy), withdrawn: [], edited: [], released: [], confirmed: [], held: [] };
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
  if (!remoteStop.takeover && !mine.handback) {
    const paused = await server("pause", { reason: TAKEOVER_REASON, takeover: true, ongoing: true }, 10_000);
    out.paused = paused.code === 0;
  }
  // Отметки на живом сервере нет и поставить её не вышло: он выпускает сам.
  out.unguarded = !remoteStop.takeover && !out.paused;

  /* Сервер старше копии: он поднят из архива либо откатан снимком диска. О том, что было
     после архива, его статусы ничего не говорят, и принимать их нельзя. Компьютер снял бы
     у себя запись с исправленным текстом, а серверу остался бы прежний, отклонённый.
     Такой сервер получает отметку «восстановлен», а копия остаётся правдой до возврата. */
  const taken = readJson(dataPath("TAKEOVER.json"), {}) || {};
  const older = Boolean(taken.copyFresh && r.data.fresh && r.data.fresh < taken.copyFresh - 60_000);
  if (r.data.restored || older) {
    if (!r.data.restored) await server("rollback", { reason: "расписание на сервере старше копии на компьютере оператора" }, 10_000);
    out.staleServer = true;
    return out;
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
         сама площадка: с компьютера её выпускает человек, посмотрев глазами. Если человек
         уже посмотрел и вернул запись в расписание (humanMoved), его решение не отменяется:
         иначе команда «переставить» молча не действовала бы, и запись не вышла бы никогда. */
      if (!held && !e.humanMoved) {
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
  if (seen.staleServer) parts.push("сервер старше копии расписания (поднят из архива либо откатан): его статусы не принимаются, правдой остаётся копия. Нужен возврат: npm run mirror -- --handback");
  if (seen.withdrawn.length) parts.push(`согласие снято: ${seen.withdrawn.join(", ")}`);
  if (seen.edited.length) parts.push(`на сервере одобрен другой текст, с компьютера не выйдет: ${seen.edited.join(", ")}`);
  if (seen.confirmed.length) parts.push(`вышло на сервере до перехвата: ${seen.confirmed.join(", ")}`);
  if (seen.released.length) parts.push(`возвращено в расписание: ${seen.released.join(", ")}`);
  if (seen.held.length) parts.push(`придержано, сервер начал и не закончил: ${seen.held.join(", ")}`);
  return parts.join("; ");
}

/**
 * Можно ли компьютеру выпускать в этом проходе. Пустая строка — можно; иначе причина.
 *
 * Два случая, когда нельзя, и оба про одно: неизвестно, не выпускает ли сервер сам.
 *   · сервер ответил, отметки перехвата на нём нет, и поставить её не удалось;
 *   · возврат оборвался на последнем запросе (сервер мог включиться, ответ потерялся),
 *     и связи с сервером с тех пор нет.
 * Во втором случае ждать можно долго, поэтому причина называет, что делать.
 */
export function takeoverDoubt(seen) {
  const file = dataPath("TAKEOVER.json");
  const state = readJson(file, {}) || {};
  if (seen?.reached) {
    if (seen.unguarded) return "сервер жив, а отметки перехвата на нём нет и поставить её не удалось: выпускать могли бы обе машины. Компьютер попробует снова при следующем проходе";
    // Отметка на сервере подтверждена: сомнение после оборванного возврата снято.
    if (state.serverMayRun) writeJson(file, { ...state, serverMayRun: false });
    return "";
  }
  if (state.serverMayRun) return "возврат оборвался на последнем запросе: сервер мог включить выпуск, а связи с ним нет. Откройте /health сервера с телефона. Сервер жив: ничего не делайте и повторите возврат, когда связь вернётся. Сервер лежит либо выпуск на нём остановлен: npm run queue -- resume --local --server-stopped";
  return "";
}
