#!/usr/bin/env node
// Выпуск по расписанию. Зовётся cron на сервере раз в пять минут:
//   */5 * * * * flock -n /tmp/zavod-release.lock node /opt/ecopolis-zavod/current/src/queue/runner.mjs
// Круглосуточно: ночью слотов нет, но проход пишет пульс, по которому видно простой.
//
// Берёт из очереди одобренные записи, чей слот наступил, и выпускает их через адаптер
// площадки. Правила ниже взяты из нашего боевого выпуска, у каждого своя причина:
//
//  · выходит только одобренное человеком клиента. Черновик не выходит никогда;
//  · проверки (готовность, речь, реклама, факты) идут ещё раз прямо перед выпуском;
//  · статус «выходит» пишется ДО отправки: второй проход эту запись не возьмёт;
//  · запись, опоздавшая больше чем на шесть часов, не выходит вовсе: пост про завтрашнюю
//    дату не должен появиться послезавтра. Человеку уходит кнопка «в ближайший слот»;
//  · после простоя опоздавшие идут по одной раз в сорок минут и не ночью. У нас четыре
//    ветки однажды вышли за пять минут, площадка режет охват такой пачке;
//  · неудавшаяся запись пробуется до трёх раз, с места обрыва и со сверкой с площадкой;
//  · об ошибке группа узнаёт сразу, обо всём остальном одной сводкой вечером;
//  · файл STOP в каталоге данных останавливает выпуск целиком. Это рубильник на случай
//    перехвата расписания компьютером оператора: двух выпускающих разом быть не должно;
//  · после простоя сервера дольше получаса выпуск сам встаёт на удержание (файл HOLD) и
//    ждёт кнопки человека. Пока сервер молчал, расписание мог вести компьютер оператора,
//    и о вышедшем там сервер ещё не знает. Без удержания он выпустил бы то же второй раз;
//  · пакет на ручную выкладку (Дзен, Rutube без ключа, ответ на комментарий) — не
//    публикация. Запись встаёт в статус «передано», а «вышло» ей ставит человек кнопкой
//    «Выложено». У нас сводка дня считала вышедшим то, что ещё лежало в группе текстом;
//  · срок выхода роликов YouTube сверяется на каждом проходе, и при остановке тоже:
//    ролик с датой выхода открывает сам YouTube, и рубильник сервера его не держит;
//  · ролик на Instagram, во ВКонтакте и на Rutube не выходит, пока не вышла запись
//    YouTube с тем же именем: YouTube — основная площадка, остальные идут следом.
//
// Запуск руками:  node src/queue/runner.mjs [--dry]

import { fileURLToPath } from "node:url";
import {randomBytes} from 'node:crypto';
import { resolveEntryMedia } from '../media/library.mjs';
import { existsSync, realpathSync } from "node:fs";
import { config, channel as channelCfg } from "../lib/config.mjs";
import { dataPath, env, wrongUser } from "../lib/env.mjs";
import { lock, readJson, writeAtomic, writeJson } from "../lib/files.mjs";
import { alert, h, report, resolve, toGroup } from "../lib/notify.mjs";
import { dueAt, human, mskDate, mskHour } from "../lib/time.mjs";
import { adapter } from "../channels/index.mjs";
import { sendReply } from "../channels/manual.mjs";
import { check } from "../gates/index.mjs";
import { ownsQueue, staleOnYoutube, syncAll as syncYoutube } from "../video/schedule.mjs";
import { STATUS_TITLE, preview } from "./format.mjs";
import { channelLoad, record } from "./ledger.mjs";
import { all, compact, forcePublished, get, patch, transition } from "./store.mjs";
import { isHeld, isRestored, isTakeover, stopState } from "./switch.mjs";
import { adoptServerState, sayAdopted, takeoverDoubt } from "./takeover.mjs";

const STUCK_MIN = 15;

const state = () => readJson(dataPath("state.json"), {}) || {};
const remember = (s) => writeJson(dataPath("state.json"), s);

/**
 * Один проход выпуска.
 * @returns {Promise<{ published: string[], handed: string[], retry: string[], failed: string[], expired: string[], waiting: string[], digest: boolean, busy?: boolean, stopped?: boolean, held?: boolean, restored?: boolean, idle?: string }>}
 *   handed — пакеты, ушедшие человеку на ручную выкладку: публикацией они ещё не стали
 */
export async function runOnce({ now = Date.now(), dry = false, sleep } = {}) {
  const out = { published: [], handed: [], retry: [], failed: [], expired: [], waiting: [], digest: false };
  const rules = config().release;

  /* На компьютере оператора лежит копия очереди, а не очередь. Выпускать по ней можно
     только при перехвате расписания. Задача аварийного выпуска, забытая включённой после
     возврата, иначе шла бы по устаревшей копии. */
  if (env("QUEUE_API_BASE") && !isTakeover()) return { ...out, stopped: true, idle: "на компьютере оператора выпуск идёт только при перехвате расписания" };

  /* Пульс пишется на каждом проходе, даже при остановке: по нему сторож на компьютере
     оператора понимает, что сервер жив, а сам выпуск видит, что молчал. Считается по
     настоящим часам, а не по параметру now: простой — это про реальное время. */
  const beatFile = dataPath("heartbeat.json");
  const prev = readJson(beatFile, {}) || {};
  const silentMin = prev.runner ? (Date.now() - Date.parse(prev.runner)) / 60_000 : 0;
  if (!dry) {
    writeJson(beatFile, { ...prev, runner: new Date().toISOString(), pid: process.pid });
    // При перехвате расписания компьютером удержание не ставится: кнопку «Продолжить»
    // обрабатывает сервер, а он как раз лежит. Компьютер после сна просто идёт дальше.
    if (rules.outageHoldMin && silentMin > rules.outageHoldMin && !isHeld() && !stopState().stopped && !isTakeover()) {
      writeAtomic(dataPath("HOLD"), JSON.stringify({ at: new Date().toISOString(), silentMin: Math.round(silentMin) }));
    }
    if (isTakeover()) {
      /* Перехват: перед проходом компьютер спрашивает сервер, не остановил ли человек
         выпуск и не снял ли записи после копии. Сервер молчит — идём по копии. */
      const seen = await adoptServerState().catch(() => ({ reached: false }));
      const said = sayAdopted(seen);
      if (said) console.log(`${new Date().toISOString()} сверка с сервером: ${said}`);
      /* Выпускает всегда кто-то один. Если неизвестно, не выпускает ли сервер сам (он жив и
         без отметки перехвата либо возврат оборвался на последнем запросе), компьютер
         этот проход пропускает. */
      const doubt = takeoverDoubt(seen);
      if (doubt) {
        console.log(`${new Date().toISOString()} перехват: проход пропущен. ${doubt}`);
        return { ...out, stopped: true, idle: doubt };
      }
    }
    if (ownsQueue()) {
      /* Сроки роликов YouTube ведёт только хозяин очереди. Сверка стоит до рубильника
         намеренно: при остановке выпуска срок с роликов как раз и нужно снять. Сбой
         сверки выпуск не роняет. */
      await precheckYoutube(now).catch((e) => console.error(`${new Date().toISOString()} проверка роликов YouTube перед выпуском не прошла: ${e?.message || e}`));
      await syncYoutube({ now }).catch((e) => console.error(`${new Date().toISOString()} сверка сроков YouTube не прошла: ${e?.message || e}`));
    }
  }

  const stop = stopState();
  if (stop.stopped) {
    // Компьютер оператора при перехвате об остановке не пишет: о ней уже сказал сервер,
    // с которого она принята, а местную остановку оператор поставил сам.
    if (!dry && !isTakeover()) {
      /* Остановил человек: напоминаем, чем включить. Остановка только ради перехвата:
         команду /start_release не предлагаем, она тут ничего не включит, а расписание
         в это время ведёт компьютер оператора. */
      if (stop.human) await alert("release:stop", `Выпуск остановлен${stop.by ? `: ${h(stop.by)}` : ""}${stop.reason ? ` (${h(stop.reason)})` : ""}. По расписанию ничего не выходит.${stop.takeover ? " Расписание при этом перехвачено компьютером оператора: он остановится при ближайшей сверке с сервером." : ""}`, { action: "если остановка не нужна, отправьте в эту группу команду /start_release" });
      else await alert("release:stop", "Выпуск на сервере остановлен: расписание временно ведёт компьютер оператора.", { action: "ничего включать не нужно. Выпуск на сервере вернёт оператор, когда передаст серверу вышедшее. Если это сообщение приходит второй день, напишите оператору" });
    }
    return { ...out, stopped: true };
  }
  if (isRestored()) {
    /* Каталог данных развёрнут из архива. Расписание в архиве старше, чем было в минуту
       аварии: что вышло, что сняли и чему отозвали согласие после архива, сервер не знает.
       Выпустить по такому расписанию значит задвоить вышедшее и выпустить снятое. Кнопки
       здесь нет намеренно: снимает остановку только сверка с копией расписания. */
    if (!dry) {
      const mark = readJson(dataPath("RESTORED"), {}) || {};
      const from = mark.archived ? ` от ${String(mark.archived).slice(0, 16).replace("T", " ")} UTC` : "";
      await alert("release:restored", `Сервер восстановлен из архива${from}. Расписание в архиве старше, чем было в минуту аварии: что с тех пор вышло, что сняли и что одобрили, сервер не знает. Выпуск стоит, пока оператор не сверит сервер с копией расписания.`, {
        action: "перешлите это сообщение оператору. Его команда: npm run mirror -- --reconcile (если расписание вёл компьютер оператора: npm run mirror -- --handback)",
      });
    }
    return { ...out, restored: true };
  }
  if (isHeld()) {
    const hold = readJson(dataPath("HOLD"), {}) || {};
    if (!dry) {
      await alert("release:hold", `Сервер молчал ${hold.silentMin ?? "больше 30"} мин. и вернулся. Выпуск ждёт подтверждения: пока сервер молчал, расписание мог вести компьютер оператора, и вышедшее там сервер ещё не знает.`, {
        action: "спросите оператора, перехватывал ли он расписание и не восстанавливал ли сервер из архива либо снимка диска. Если нет, нажмите «Продолжить выпуск». Если да, оператор сначала вернёт серверу то, что произошло без него",
        buttons: [[{ text: "Продолжить выпуск", data: "r:go" }]],
      });
    }
    return { ...out, held: true };
  }

  const release = lock(dataPath("runner.lock"));
  if (!release) return { ...out, busy: true };
  const started = Date.now();
  const clock = () => now + (Date.now() - started);
  try {
    const hour = mskHour(now);
    const night = hour >= rules.nightFromHour || hour < rules.nightToHour;
    const entries = all().sort((a, b) => dueAt(a) - dueAt(b));

    for (const entry of entries) {
      /* «Выходит» дольше четверти часа — прошлый проход оборвался (перезапуск сервера).
         Продолжаем со сверкой: вышедшее найдётся на площадке. */
      const stuck = entry.status === "running" && now - Date.parse(entry.startedAt || entry.at) > STUCK_MIN * 60_000;
      if (entry.status !== "approved" && !stuck) continue;
      const due = dueAt(entry);
      if (!(due <= now)) continue;
      const attempts = entry.attempts ?? 0;
      const lateMin = (now - due) / 60_000;
      const cfg = channelCfg(entry.channel);
      // Ответ на комментарий — не публикация по сетке: он уходит сотруднику пакетом сразу
      // после согласования, не считается в потолок площадки и не «просрочивается».
      const isReply = entry.kind === "reply";

      if (!isReply && lateMin > rules.lateLimitHours * 60 && !(entry.done?.length)) {
        /* Ролик YouTube с датой выхода открывает сам YouTube. После долгого простоя
           сервера он давно открыт, и «не вышла» было бы неправдой: сначала спрашиваем
           площадку. Остальные адаптеры такого не умеют, и для них правило прежнее. */
        const mod = dry ? null : await adapter(entry.channel).catch(() => null);
        const live = mod?.already ? await mod.already(entry).catch(() => null) : null;
        if (live) {
          const at = new Date(clock()).toISOString();
          const done = await forcePublished(entry.id, { result: { ...(entry.result || {}), id: live.id, link: live.link }, publishedAt: at, note: "вышла сама, пока выпуск молчал: найдена на площадке" }, "выпуск");
          record(done, "published", { externalId: live.id, link: live.link, at });
          out.published.push(entry.name);
          continue;
        }
        out.expired.push(entry.name);
        if (!dry) {
          await transition(entry.id, "expired", { note: `просрочена на ${(lateMin / 60).toFixed(1)} ч` }, "выпуск");
          record(entry, "expired");
          const token=randomBytes(8).toString('hex');
          const alarm=await toGroup("alerts", `⏭ <b>${h(cfg.title)}</b>: «${h(entry.name)}» не вышла, её слот (${human(entry)}) прошёл больше ${rules.lateLimitHours} часов назад.\n«${h(preview(entry))}»`, {
            buttons: [[{ text: "В ближайший слот", data: `q:next:${entry.id}:${token}` }, { text: "Снять", data: `q:no:${entry.id}:${token}` }]],
          });
          if(alarm.ok&&alarm.messageId)await patch(entry.id,{recoveryCard:{messageId:alarm.messageId,token,hash:entry.contentHash}},'выпуск');
        }
        continue;
      }

      /* Ролик на другой площадке ждёт премьеры на YouTube. Слот ему и так подобран после
         неё, но премьера может не состояться в срок: ролик не загрузили, площадка отказала.
         Тогда остальные площадки стоят, пока запись YouTube с тем же именем не выйдет.
         Ждут они не вечно: через шесть часов запись просрочится, и человеку уйдёт кнопка. */
      if (!isReply && entry.channel !== "youtube" && ["video", "short", "reel"].includes(entry.kind)) {
        const first = entries.find((e) => e.channel === "youtube" && e.name === entry.name && e.status !== "cancelled");
        if (first && get(first.id)?.status !== "published") { out.waiting.push(entry.name); continue; }
      }

      const load = channelLoad(entry.channel, now);
      // Догон после простоя и потолки площадки. Повтор и продолжение сюда не относятся.
      if (attempts === 0 && !stuck && !isReply) {
        const lateCatchUp = lateMin > rules.lateAfterMin && (night || now - load.last < rules.catchUpGapMin * 60_000);
        const tooSoon = cfg.minGapMin && now - load.last < cfg.minGapMin * 60_000;
        const dayFull = cfg.perDay && load.lastDay >= cfg.perDay;
        if (lateCatchUp || tooSoon || dayFull) { out.waiting.push(entry.name); continue; }
      }

      /* Вторая застава: проверки прямо перед выпуском. Здесь останавливают только две
         из пяти: готовность (заглушка в тексте) и реклама. Речь, факты и замечания к
         ролику человек уже видел в карточке и сказал «да»; останавливать ими одобренное
         нельзя. У нас новая
         проверка фактов однажды за день сняла шесть одобренных постов, и ни один из них
         не был плохим. */
      const verdict = check(entry, now);
      const hard = verdict.block.filter((b) => HARD.test(b));
      if (hard.length) {
        out.failed.push(entry.name);
        if (!dry) {
          if (entry.status === "approved") await transition(entry.id, "review", { note: `проверка перед выпуском: ${hard[0]}`, approval: undefined }, "выпуск");
          await alert(`gate:${entry.id}`, `<b>${h(cfg.title)}</b>: «${h(entry.name)}» не вышла, проверка перед выпуском не пустила.\n${h(hard.join("\n"))}`, { action: "передайте оператору: текст нужно поправить и согласовать заново" });
        }
        continue;
      }
      if (dry) { out.published.push(entry.name); continue; }

      /* «Стоп» мог прийти, пока шёл этот проход: первая запись ушла, вторая ещё нет. Бот
         в эту минуту уже ответил человеку «ничего не выйдет», поэтому следующую запись
         проход не берёт. */
      if (stopState().stopped) { out.stopped = true; break; }

      let current;
      try {
        const mark = { startedAt: new Date(clock()).toISOString(), attempts: attempts + 1 };
        // Застрявшая запись уже в статусе «выходит»: перехода нет, только новая отметка времени.
        current = stuck ? await patch(entry.id, mark, "выпуск") : await transition(entry.id, "running", mark, "выпуск");
      } catch (e) {
        if (e.code === "RULE") continue; // запись только что сняли или отозвали кнопкой
        throw e;
      }

      const mod = isReply ? { publish: (e, ctx) => sendReply(e, ctx) } : await adapter(entry.channel);
      let result;
      try {
        const withMedia=await resolveEntryMedia(current);
        result = await mod.publish(withMedia, {
          sleep,
          verify: attempts > 0 || stuck || Boolean(entry.done?.length),
          onStep: async (done, link) => { current = await patch(current.id, { done, result: { ...(current.result || {}), link } }, "выпуск"); },
          // Промежуточное состояние площадки (номер контейнера, номер загрузки): с ним повтор
          // после обрыва продолжает начатое, а не создаёт второе.
          onState: async (fields) => { current = await patch(current.id, { result: { ...(current.result || {}), ...fields } }, "выпуск"); },
        });
      } catch (e) {
        result = { ok: false, error: `сбой адаптера: ${e?.message || e}`, retry: true };
      }

      if (result.ok) {
        // Промежуточное состояние (номер контейнера, номер сообщения-пакета) сохраняем:
        // по нему ответ со ссылкой находит запись, а повтор не создаёт второе.
        const res = { ...(current.result || {}), id: result.id || "", link: result.link || current.result?.link || "", ...(result.messageIds ? {messageIds:result.messageIds,mediaGroupId:result.mediaGroupId} : {}), ...(result.manual ? { manual: "пакет отправлен, ждёт ручной выкладки" } : {}) };
        const at = new Date(clock()).toISOString();
        if (result.manual) {
          // Пакет ушёл человеку: на площадке ещё ничего нет. «Вышло» поставит кнопка «Выложено».
          await transition(current.id, "handed", { done: result.done, result: res, handedAt: at, note: result.note }, "выпуск");
          record(current, "handed", { at });
          out.handed.push(entry.name);
        } else {
          await transition(current.id, "published", { done: result.done, result: res, publishedAt: at, note: result.note }, "выпуск");
          record(current, "published", { externalId: res.id, link: res.link, at, ...(res.messageIds ? {externalIds:res.messageIds,mediaGroupId:res.mediaGroupId} : {}) });
          out.published.push(entry.name);
        }
        resolve(`publish:${current.id}`);
        continue;
      }

      const keep = { done: result.done ?? current.done, result: { ...(current.result || {}), ...(result.link ? { link: result.link } : {}) }, note: result.error };
      if (result.retry !== false && attempts + 1 < rules.attempts) {
        await transition(current.id, "approved", keep, "выпуск");
        out.retry.push(entry.name);
        continue;
      }
      await transition(current.id, "failed", keep, "выпуск");
      record(current, "failed", { error: result.error });
      out.failed.push(entry.name);
      const part = keep.done?.length ? `\nВышло частей: ${keep.done.length} из ${current.posts?.length ?? 1}${keep.result?.link ? `, начало: ${h(keep.result.link)}` : ""}. Хвост дописывается руками.` : "";
      const token=randomBytes(8).toString('hex');
      const alarm=await alert(`publish:${current.id}`, `<b>${h(cfg.title)}</b>: «${h(entry.name)}» (${human(entry)}) не вышла с ${attempts + 1} попыток.\n${h(result.error || "причина не названа")}${part}`, {
        action: "передайте оператору это сообщение; после починки кнопка вернёт запись в очередь",
        buttons: [[{ text: "Вернуть в ближайший слот", data: `q:next:${current.id}:${token}` }, { text: "Снять", data: `q:no:${current.id}:${token}` }]],
      });
      if(alarm.ok&&alarm.messageId)await patch(current.id,{recoveryCard:{messageId:alarm.messageId,token,hash:current.contentHash}},'выпуск');
    }

    if (!dry) {
      // При перехвате о согласовании не напоминаем: новое «да» компьютер не принимает,
      // и просьба «нажмите „Одобрить“» обещала бы выход, которого не будет.
      if (!isTakeover()) await nudges(now);
      const s = state();
      const day = mskDate(now);
      if (hour >= rules.morningHour && hour < 12 && s.morningDay !== day) {
        await report(morning(all(), now));
        remember({ ...state(), morningDay: day });
      }
      if (hour >= rules.digestHour && s.digestDay !== day) {
        await report(digest(all(), now));
        remember({ ...state(), digestDay: day });
        await compact(now).catch(() => 0);
        out.digest = true;
      }
    }
    return out;
  } finally {
    release();
  }
}

const HARD = /^(?:готовность|реклама):/;

/**
 * Вторая застава для роликов YouTube ставится заранее, а не в минуту слота.
 *
 * Обычную запись проверка останавливает прямо перед отправкой на площадку. Загруженный
 * ролик так не остановить: в минуту слота его открывает сам YouTube, и проверка, сделанная
 * в ту же минуту, опоздала бы. Поэтому готовность и реклама для загруженных роликов
 * смотрятся на каждом проходе. Не прошла — согласие снимается сейчас, и сверка сроков
 * следом убирает дату с ролика, пока до неё есть время.
 */
async function precheckYoutube(now) {
  for (const entry of all()) {
    if (entry.channel !== "youtube" || entry.status !== "approved" || !entry.extra?.youtubeId) continue;
    const hard = check(entry, now).block.filter((b) => HARD.test(b));
    if (!hard.length) continue;
    await transition(entry.id, "review", { note: `проверка перед выпуском: ${hard[0]}`, approval: undefined }, "выпуск");
    await alert(`gate:${entry.id}`, `<b>${h(channelCfg(entry.channel).title)}</b>: «${h(entry.name)}» не выйдет, проверка перед выпуском не пустила. Срок выхода с ролика на YouTube снимается.\n${h(hard.join("\n"))}`, { action: "передайте оператору: запись нужно поправить и согласовать заново" });
  }
}

/** Напоминание утверждающему: слот близко, а «да» ещё нет. Одно на запись. */
async function nudges(now) {
  const hours = config().approval?.nudgeHoursBeforeSlot ?? 3;
  const soon = all().filter((e) => e.status === "review" && !e.nudged && dueAt(e) - now < hours * 3600_000 && dueAt(e) > now - 3600_000);
  if (!soon.length) return;
  const lines = soon.map((e) => `${e.time} · ${h(channelCfg(e.channel).title)} · ${h(preview(e, 60))}`);
  const res = await toGroup("approval", `⏳ <b>Ждут согласования, слот близко: ${soon.length}</b>\n${lines.join("\n")}\n\nКарточки выше в этой теме: нажмите «Одобрить» или «Правка».`);
  if (res.ok) for (const e of soon) await patch(e.id, { nudged: true }, "выпуск");
}

const byDue = (a, b) => dueAt(a) - dueAt(b);
const line = (e) => `${e.time} · ${h(channelCfg(e.channel).title)} · ${h(preview(e, 56))}`;

/** Утро: что стоит на сегодня и что ждёт «да». Сверху расписание дня, это главное. */
export function morning(entries, now) {
  const today = mskDate(now);
  const [, month, dayNum] = today.split("-");
  const day = entries.filter((e) => e.date === today && !["cancelled", "draft", "rework"].includes(e.status)).sort(byDue);
  const ready = day.filter((e) => e.status === "approved");
  const waiting = day.filter((e) => e.status === "review");
  const rows = [`<b>План на ${Number(dayNum)}.${month}: одобрено ${ready.length}, ждёт согласования ${waiting.length}</b>`];
  if (!day.length) rows.push("На сегодня в очереди пусто.");
  for (const e of ready) rows.push(line(e));
  if (waiting.length) {
    rows.push("", "<b>Ждут «да» сегодня</b>");
    for (const e of waiting) rows.push(line(e));
  }
  const rework = entries.filter((e) => e.status === "rework");
  if (rework.length) rows.push("", `На правке у оператора: ${rework.length}.`);
  // Запись одобрена после правки, а на ролике ещё прежние название и описание: до команды
  // оператора ролик закрыт и в слот не выйдет. Молчать об этом до минуты слота нельзя.
  const stale = entries.filter((e) => e.status === "approved" && staleOnYoutube(e)).sort(byDue);
  if (stale.length) rows.push("", `<b>Одобрены, но на YouTube лежит прежний текст: ${stale.length}</b>`, ...stale.map((e) => `${e.date.slice(8, 10)}.${e.date.slice(5, 7)} ${line(e)}`), "Оператор отправляет на ролик новый текст командой; до этого ролик закрыт и в слот не выйдет.");
  rows.push(...handedRows(entries));
  return rows.join("\n");
}

/** Пакеты, которые ушли человеку и ждут отметки «Выложено»: за любой день, не только сегодня. */
function handedRows(entries) {
  const handed = entries.filter((e) => e.status === "handed").sort(byDue);
  if (!handed.length) return [];
  return ["", `<b>Переданы на ручную выкладку, отметки «Выложено» нет: ${handed.length}</b>`, ...handed.map((e) => `${e.date.slice(8, 10)}.${e.date.slice(5, 7)} ${line(e)}`), "Текст лежит в теме «Выложить руками». Кнопка под ним отмечает запись вышедшей."];
}

/** Вечер: что вышло, что нет и почему, что стоит на завтра. Одно сообщение на день. */
export function digest(entries, now) {
  const today = mskDate(now);
  const tomorrow = mskDate(now + 86_400_000);
  const [, month, dayNum] = today.split("-");
  const day = entries.filter((e) => e.date === today && !["cancelled", "draft", "rework"].includes(e.status)).sort(byDue);
  const out = day.filter((e) => e.status === "published");
  // Переданное человеку не «вышло» и не «не вышло»: оно стоит отдельной строкой ниже.
  const not = day.filter((e) => e.status !== "published" && e.status !== "handed");
  const rows = [`<b>Итог ${Number(dayNum)}.${month}: вышло ${out.length} из ${day.length}</b>`];
  for (const e of out) rows.push(`${line(e)}${e.result?.link ? ` · <a href="${h(e.result.link)}">открыть</a>` : ""}`);
  if (not.length) {
    rows.push("", "<b>Не вышло</b>");
    for (const e of not) rows.push(`${line(e)}: ${STATUS_TITLE[e.status] || e.status}${e.note && ["failed", "review"].includes(e.status) ? `, ${h(String(e.note).slice(0, 100))}` : ""}`);
  }
  rows.push(...handedRows(entries));
  const next = entries.filter((e) => e.date === tomorrow && ["approved", "review"].includes(e.status)).sort(byDue);
  const approved = next.filter((e) => e.status === "approved").length;
  rows.push("", next.length ? `<b>Завтра в очереди: ${next.length}</b>, одобрено ${approved}, ждёт «да» ${next.length - approved}.` : "На завтра в очереди пусто.");
  for (const e of next) rows.push(`${line(e)}${e.status === "review" ? " · ждёт «да»" : ""}`);
  return rows.join("\n");
}

// Node раскрывает current в import.meta.url, а argv оставляет путём через ссылку.
// Сравниваем реальные пути, иначе cron завершается успешно, не выполнив проход.
const direct = process.argv[1] && existsSync(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (direct && wrongUser() && !process.argv.includes("--dry")) {
  // Расписание, поставленное в crontab пользователя root, портит каталог данных с первого прохода.
  console.error(`${new Date().toISOString()} выпуск не запущен: ${wrongUser()}. Расписание ставится так: crontab -u zavod ops/crontab.txt`);
  process.exitCode = 2;
} else if (direct) {
  const dry = process.argv.includes("--dry");
  runOnce({ dry }).then(
    (r) => {
      const quiet = !r.published.length && !r.handed.length && !r.retry.length && !r.failed.length && !r.expired.length && !r.waiting.length && !r.digest;
      // Пустой проход в журнал не пишем: их двести в сутки.
      if (!quiet || dry || r.busy || r.stopped || r.held || r.restored) console.log(`${new Date().toISOString()} ${dry ? "проба " : ""}${JSON.stringify(r)}`);
      process.exitCode = r.failed.length ? 1 : 0;
    },
    (e) => {
      console.error(`${new Date().toISOString()} сбой выпуска: ${e?.stack || e}`);
      process.exitCode = 2;
    },
  );
}
