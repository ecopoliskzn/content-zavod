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
//    и о вышедшем там сервер ещё не знает. Без удержания он выпустил бы то же второй раз.
//
// Запуск руками:  node src/queue/runner.mjs [--dry]

import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config, channel as channelCfg } from "../lib/config.mjs";
import { dataPath } from "../lib/env.mjs";
import { lock, readJson, writeJson } from "../lib/files.mjs";
import { alert, h, report, resolve, toGroup } from "../lib/notify.mjs";
import { dueAt, human, mskDate, mskHour } from "../lib/time.mjs";
import { adapter } from "../channels/index.mjs";
import { check } from "../gates/index.mjs";
import { STATUS_TITLE, preview } from "./format.mjs";
import { channelLoad, record } from "./ledger.mjs";
import { all, compact, patch, transition } from "./store.mjs";

const STUCK_MIN = 15;

const state = () => readJson(dataPath("state.json"), {}) || {};
const remember = (s) => writeJson(dataPath("state.json"), s);

/**
 * Один проход выпуска.
 * @returns {Promise<{ published: string[], retry: string[], failed: string[], expired: string[], waiting: string[], digest: boolean, busy?: boolean, stopped?: boolean, held?: boolean }>}
 */
export async function runOnce({ now = Date.now(), dry = false, sleep } = {}) {
  const out = { published: [], retry: [], failed: [], expired: [], waiting: [], digest: false };
  const rules = config().release;

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
    if (rules.outageHoldMin && silentMin > rules.outageHoldMin && !existsSync(dataPath("HOLD")) && !existsSync(dataPath("STOP")) && !existsSync(dataPath("TAKEOVER.json"))) {
      writeFileSync(dataPath("HOLD"), JSON.stringify({ at: new Date().toISOString(), silentMin: Math.round(silentMin) }), "utf8");
    }
  }

  if (existsSync(dataPath("STOP"))) {
    if (!dry) await alert("release:stop", "Выпуск остановлен: в каталоге данных лежит файл STOP.", { action: "если остановка не нужна, отправьте в эту группу команду /start_release" });
    return { ...out, stopped: true };
  }
  if (existsSync(dataPath("HOLD"))) {
    const hold = readJson(dataPath("HOLD"), {}) || {};
    if (!dry) {
      await alert("release:hold", `Сервер молчал ${hold.silentMin ?? "больше 30"} мин. и вернулся. Выпуск ждёт подтверждения: пока сервер молчал, расписание мог вести компьютер оператора, и вышедшее там сервер ещё не знает.`, {
        action: "спросите оператора, перехватывал ли он расписание. Если нет, нажмите «Продолжить выпуск». Если да, оператор сначала вернёт вышедшее на сервер",
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

      if (lateMin > rules.lateLimitHours * 60 && !(entry.done?.length)) {
        out.expired.push(entry.name);
        if (!dry) {
          await transition(entry.id, "expired", { note: `просрочена на ${(lateMin / 60).toFixed(1)} ч` }, "выпуск");
          record(entry, "expired");
          await toGroup("alerts", `⏭ <b>${h(cfg.title)}</b>: «${h(entry.name)}» не вышла, её слот (${human(entry)}) прошёл больше ${rules.lateLimitHours} часов назад.\n«${h(preview(entry))}»`, {
            buttons: [[{ text: "В ближайший слот", data: `q:next:${entry.id}` }, { text: "Снять", data: `q:no:${entry.id}` }]],
          });
        }
        continue;
      }

      const load = channelLoad(entry.channel, now);
      // Догон после простоя и потолки площадки. Повтор и продолжение сюда не относятся.
      if (attempts === 0 && !stuck) {
        const lateCatchUp = lateMin > rules.lateAfterMin && (night || now - load.last < rules.catchUpGapMin * 60_000);
        const tooSoon = cfg.minGapMin && now - load.last < cfg.minGapMin * 60_000;
        const dayFull = cfg.perDay && load.lastDay >= cfg.perDay;
        if (lateCatchUp || tooSoon || dayFull) { out.waiting.push(entry.name); continue; }
      }

      /* Вторая застава: проверки прямо перед выпуском. Здесь останавливают только две
         из четырёх: готовность (заглушка в тексте) и реклама. Речь и факты человек уже
         видел в карточке и сказал «да»; останавливать ими одобренное нельзя. У нас новая
         проверка фактов однажды за день сняла шесть одобренных постов, и ни один из них
         не был плохим. */
      const verdict = check(entry, now);
      const hard = verdict.block.filter((b) => /^(?:готовность|реклама):/.test(b));
      if (hard.length) {
        out.failed.push(entry.name);
        if (!dry) {
          if (entry.status === "approved") await transition(entry.id, "review", { note: `проверка перед выпуском: ${hard[0]}`, approval: undefined }, "выпуск");
          await alert(`gate:${entry.id}`, `<b>${h(cfg.title)}</b>: «${h(entry.name)}» не вышла, проверка перед выпуском не пустила.\n${h(hard.join("\n"))}`, { action: "передайте оператору: текст нужно поправить и согласовать заново" });
        }
        continue;
      }
      if (dry) { out.published.push(entry.name); continue; }

      let current;
      try {
        const mark = { startedAt: new Date(clock()).toISOString(), attempts: attempts + 1 };
        // Застрявшая запись уже в статусе «выходит»: перехода нет, только новая отметка времени.
        current = stuck ? await patch(entry.id, mark, "выпуск") : await transition(entry.id, "running", mark, "выпуск");
      } catch (e) {
        if (e.code === "RULE") continue; // запись только что сняли или отозвали кнопкой
        throw e;
      }

      const mod = await adapter(entry.channel);
      let result;
      try {
        result = await mod.publish(current, {
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
        const res = { ...(current.result || {}), id: result.id || "", link: result.link || current.result?.link || "", ...(result.manual ? { manual: "пакет отправлен, ждёт ручной выкладки" } : {}) };
        await transition(current.id, "published", { done: result.done, result: res, publishedAt: new Date(clock()).toISOString(), note: result.note }, "выпуск");
        record(current, result.manual ? "handed" : "published", { externalId: res.id, link: res.link, at: new Date(clock()).toISOString() });
        resolve(`publish:${current.id}`);
        out.published.push(entry.name);
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
      await alert(`publish:${current.id}`, `<b>${h(cfg.title)}</b>: «${h(entry.name)}» (${human(entry)}) не вышла с ${attempts + 1} попыток.\n${h(result.error || "причина не названа")}${part}`, {
        action: "передайте оператору это сообщение; после починки кнопка вернёт запись в очередь",
        buttons: [[{ text: "Вернуть в ближайший слот", data: `q:next:${current.id}` }, { text: "Снять", data: `q:no:${current.id}` }]],
      });
    }

    if (!dry) {
      await nudges(now);
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
  return rows.join("\n");
}

/** Вечер: что вышло, что нет и почему, что стоит на завтра. Одно сообщение на день. */
export function digest(entries, now) {
  const today = mskDate(now);
  const tomorrow = mskDate(now + 86_400_000);
  const [, month, dayNum] = today.split("-");
  const day = entries.filter((e) => e.date === today && !["cancelled", "draft", "rework"].includes(e.status)).sort(byDue);
  const out = day.filter((e) => e.status === "published");
  const not = day.filter((e) => e.status !== "published");
  const rows = [`<b>Итог ${Number(dayNum)}.${month}: вышло ${out.length} из ${day.length}</b>`];
  for (const e of out) rows.push(`${line(e)}${e.result?.link ? ` · <a href="${h(e.result.link)}">открыть</a>` : ""}`);
  if (not.length) {
    rows.push("", "<b>Не вышло</b>");
    for (const e of not) rows.push(`${line(e)}: ${STATUS_TITLE[e.status] || e.status}${e.note && ["failed", "review"].includes(e.status) ? `, ${h(String(e.note).slice(0, 100))}` : ""}`);
  }
  const next = entries.filter((e) => e.date === tomorrow && ["approved", "review"].includes(e.status)).sort(byDue);
  const approved = next.filter((e) => e.status === "approved").length;
  rows.push("", next.length ? `<b>Завтра в очереди: ${next.length}</b>, одобрено ${approved}, ждёт «да» ${next.length - approved}.` : "На завтра в очереди пусто.");
  for (const e of next) rows.push(`${line(e)}${e.status === "review" ? " · ждёт «да»" : ""}`);
  return rows.join("\n");
}

const direct = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (direct) {
  const dry = process.argv.includes("--dry");
  runOnce({ dry }).then(
    (r) => {
      const quiet = !r.published.length && !r.retry.length && !r.failed.length && !r.expired.length && !r.waiting.length && !r.digest;
      // Пустой проход в журнал не пишем: их двести в сутки.
      if (!quiet || dry || r.busy || r.stopped || r.held) console.log(`${new Date().toISOString()} ${dry ? "проба " : ""}${JSON.stringify(r)}`);
      process.exitCode = r.failed.length ? 1 : 0;
    },
    (e) => {
      console.error(`${new Date().toISOString()} сбой выпуска: ${e?.stack || e}`);
      process.exitCode = 2;
    },
  );
}
