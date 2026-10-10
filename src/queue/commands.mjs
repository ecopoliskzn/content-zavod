// Команды очереди. Одна реализация на два входа: командная строка на сервере и ручка
// /admin/queue, через которую с очередью работает компьютер оператора.
//
// КОДЫ ВЫХОДА — РАЗНЫЕ ВЕЩИ, смешивать нельзя:
//   0 — сделано;
//   1 — отказ ПО ПРАВИЛУ: проверки не пройдены, переход запрещён. Это ответ человеку;
//   2 — поломка окружения: нет ключа, сеть, не читается файл. Это чинится.
// Смешаете — оператор побежит чинить сервер там, где ему просто отказали.

import { channel as channelCfg, channelNames } from "../lib/config.mjs";
import { alert, h, resolve as resolveAlert } from "../lib/notify.mjs";
import { dueAt, human, mskDate, mskTime } from "../lib/time.mjs";
import { check } from "../gates/index.mjs";
import { inbox, submit } from "../bot/approval.mjs";
import { afterChange as syncYoutube, sayAll, syncAll } from "../video/schedule.mjs";
import { STATUS_TITLE, normalize, preview, validate } from "./format.mjs";
import { record } from "./ledger.mjs";
import { aheadOfPremiere, nextSlot, premiereOf, slotFor, slotTaken } from "./slots.mjs";
import { all, forceHanded, forcePublished, get, history, patch, put, reschedule, transition } from "./store.mjs";
import { clearStop, setStop, stopState } from "./switch.mjs";

const byDue = (a, b) => dueAt(a) - dueAt(b);

/** Все записи с этим номером либо именем. Имя ролика одно на четыре площадки. */
function findAll(ref, channel) {
  const direct = get(ref);
  if (direct) return [direct];
  return all().filter((e) => e.name === ref && (!channel || e.channel === channel));
}

/** Найти запись по номеру или по имени (имя уникально в пределах площадки). */
function find(ref, channel) {
  const named = findAll(ref, channel);
  if (named.length === 1) return named[0];
  if (named.length > 1) throw Object.assign(new Error(`имя «${ref}» есть на нескольких площадках (${named.map((e) => e.channel).join(", ")}): добавьте --channel=<площадка>`), { code: "RULE" });
  throw Object.assign(new Error(`записи «${ref}» в очереди нет`), { code: "RULE" });
}

/** Номер Telegram человека клиента наружу не отдаём: в выводе остаётся «рабочая группа». */
const actorName = (by) => (/^tg:\d+$/.test(String(by || "")) ? "рабочая группа" : String(by || ""));
function withoutIds(entry) {
  const out = { ...entry, by: actorName(entry.by) };
  for (const field of ["approval", "fixAsked"]) {
    if (out[field] && typeof out[field] === "object") { const { by, ...rest } = out[field]; out[field] = rest; }
  }
  return out;
}

/** Сроки роликов YouTube после рубильника: строки для оператора. Сбой рубильник не роняет. */
async function youtubeAfterSwitch() {
  try { const said = sayAll(await syncAll()); return said ? said.split("\n") : []; } catch (e) { return [`сроки роликов YouTube сверить не удалось (${e?.message || e}): сервер повторит попытку через пять минут`]; }
}

const row = (e) => `${e.id}  ${e.date} ${e.time}  ${e.channel.padEnd(9)} ${String(STATUS_TITLE[e.status] || e.status).padEnd(20)} ${preview(e, 60)}`;

/**
 * @param {string} cmd
 * @param {Record<string, any>} args
 * @param {string} actor кто делает: «S1», «оператор», «api»
 * @returns {Promise<{ code: 0|1|2, lines: string[], data?: any }>}
 */
export async function execute(cmd, args = {}, actor = "оператор") {
  const lines = [];
  try {
    switch (cmd) {
      case "add": {
        // args.entries — одна или несколько записей, уже прочитанных из файла.
        const entries = Array.isArray(args.entries) ? args.entries : [args.entries];
        for (const raw of entries) {
          const e = normalize(raw);
          if (e.kind === "reply" && (!e.date || !e.time)) {
            // Ответ не ждёт слота площадки: уходит сотруднику сразу после согласования.
            const soon = Date.now() + 10 * 60_000;
            Object.assign(e, { date: mskDate(soon), time: mskTime(soon) });
          }
          const queue = all();
          const cfg = channelCfg(e.channel);
          if (!e.date || !e.time) {
            // Слот по рабочей сетке площадки; ролик на остальных площадках — после премьеры на YouTube.
            const slot = slotFor(e, queue, cfg);
            if (!slot) throw Object.assign(new Error(`у площадки ${e.channel} нет свободных слотов на два месяца вперёд`), { code: "RULE" });
            Object.assign(e, slot);
          } else if (e.kind !== "reply") {
            // Время задано руками: сетку оно обходит, поэтому о каждом отступлении говорим.
            if (slotTaken(queue.filter((x) => x.channel === e.channel), e.date, e.time, e.id)) lines.push(`внимание: слот ${e.date} ${e.time} на ${e.channel} уже занят другой записью`);
            if (cfg.slots?.length && !cfg.slots.includes(e.time)) lines.push(`внимание: времени ${e.time} нет среди слотов площадки ${e.channel} (${cfg.slots.join(", ")})`);
            const premiere = premiereOf(queue, e);
            if (premiere && dueAt(e) <= premiere) lines.push(`внимание: этот же ролик выходит на YouTube ${mskDate(premiere)} в ${mskTime(premiere)}, а здесь стоит раньше. YouTube идёт первым: поставьте запись без --date и --time, слот подберётся сам`);
          }
          const { entry, result } = await put(e, actor);
          const verdict = check(entry);
          lines.push(`${result}: ${row(entry)}`);
          for (const b of verdict.block) lines.push(`  ⛔ ${b}`);
          for (const w of verdict.warn) lines.push(`  ⚠ ${w}`);
          // Текст одобренного ролика изменили: согласия больше нет, срок на YouTube снимается.
          const yt = await syncYoutube(entry.id);
          if (yt) lines.push(`  ${yt}`);
          for (const x of aheadOfPremiere(all(), entry)) lines.push(`  внимание: этот ролик на ${x.channel} стоит на ${x.date} ${x.time}, не позже премьеры на YouTube. Переставьте: npm run queue -- move ${x.name} --channel=${x.channel} --next`);
        }
        return { code: 0, lines };
      }
      case "list": {
        const days = Number(args.days) || 7;
        const from = Date.now() - 24 * 3600_000;
        const to = Date.now() + days * 24 * 3600_000;
        const found = all()
          .filter((e) => (!args.channel || e.channel === args.channel) && (!args.status || e.status === args.status))
          .filter((e) => args.all || (dueAt(e) >= from && dueAt(e) <= to) || ["draft", "rework", "review"].includes(e.status))
          .sort(byDue);
        if (!found.length) lines.push("очередь пуста");
        for (const e of found) lines.push(row(e));
        return { code: 0, lines, data: found.map(withoutIds) };
      }
      case "show": {
        const e = find(args.ref, args.channel);
        lines.push(row(e), "");
        if (e.kind === "thread") e.posts.forEach((p, i) => lines.push(`— ${i + 1} —`, p, ""));
        else lines.push(e.title ? `# ${e.title}\n` : "", e.text || "");
        if (e.note) lines.push(`заметка: ${e.note}`);
        if (e.result?.link) lines.push(`ссылка: ${e.result.link}`);
        if (e.approval?.name) lines.push(`одобрил(а): ${e.approval.name}, ${e.approval.at}`);
        // Вывод уходит на компьютер оператора: номера Telegram людей клиента в нём не нужны.
        if (args.history) for (const h of history(e.id)) lines.push(`  ${h.at} ${actorName(h.by)} → ${STATUS_TITLE[h.status] || h.status}`);
        return { code: 0, lines, data: withoutIds(e) };
      }
      case "check": {
        const e = args.entry ? normalize(args.entry) : find(args.ref, args.channel);
        const verdict = check(e);
        if (args.entry) {
          // Файл ещё не в очереди: заодно проверяем форму. Пустой слот не ошибка,
          // его подберёт постановка.
          const format = validate(e).filter((b) => !(b.startsWith("дата и время") && !e.date && !e.time));
          verdict.block.unshift(...format.map((b) => `формат: ${b}`));
        }
        for (const b of verdict.block) lines.push(`⛔ ${b}`);
        for (const w of verdict.warn) lines.push(`⚠ ${w}`);
        if (!verdict.block.length) lines.push(verdict.warn.length ? "проверки пройдены, есть замечания" : "проверки пройдены");
        return { code: verdict.block.length ? 1 : 0, lines, data: verdict };
      }
      case "submit": {
        // Имя ролика одно на четыре площадки: «submit <имя>» отправляет все его черновики
        // разом, утверждающий получает четыре карточки подряд.
        let targets;
        if (args.ref) {
          const named = findAll(args.ref, args.channel);
          if (!named.length) throw Object.assign(new Error(`записи «${args.ref}» в очереди нет`), { code: "RULE" });
          targets = named.length > 1 ? named.filter((e) => ["draft", "rework"].includes(e.status)) : named;
          if (!targets.length) lines.push(`по имени «${args.ref}» черновиков нет: ${named.map((e) => `${e.channel} — ${STATUS_TITLE[e.status] || e.status}`).join(", ")}`);
        } else {
          targets = all().filter((e) => e.status === "draft" && (!args.channel || e.channel === args.channel));
          if (!targets.length) lines.push("черновиков нет");
        }
        let refused = 0;
        for (const e of targets) {
          try {
            const sent = await submit(e.id, actor);
            lines.push(`на согласовании: ${row(sent)}`);
          } catch (err) {
            if (err.code !== "RULE") throw err;
            refused++;
            lines.push(`не ушла: ${e.name}: ${err.message}`);
          }
        }
        return { code: refused ? 1 : 0, lines };
      }
      case "inbox": {
        const items = inbox();
        if (!items.length) lines.push("правок от утверждающего нет");
        for (const i of items) lines.push(`${i.id} ${i.channel} ${i.name}\n  ${i.by ? i.by + ": " : ""}${i.note}\n  было: ${i.preview}`);
        return { code: 0, lines, data: items };
      }
      case "move": {
        const e = find(args.ref, args.channel);
        let { date, time } = args;
        if (args.next || !date || !time) {
          const slot = slotFor(e, all(), channelCfg(e.channel));
          if (!slot) throw Object.assign(new Error("свободных слотов нет"), { code: "RULE" });
          ({ date, time } = slot);
        }
        const moved = await reschedule(e.id, date, time, actor);
        lines.push(`переставлена на ${human(moved)}: ${row(moved)}`);
        const premiere = premiereOf(all(), moved);
        if (premiere && dueAt(moved) <= premiere) lines.push(`внимание: этот же ролик выходит на YouTube ${mskDate(premiere)} в ${mskTime(premiere)}, а здесь стоит раньше. YouTube идёт первым: npm run queue -- move ${moved.name} --channel=${moved.channel} --next`);
        // Срок на YouTube переезжает вместе со слотом: иначе ролик откроется по старому.
        const yt = await syncYoutube(moved.id);
        if (yt) lines.push(yt);
        for (const x of aheadOfPremiere(all(), moved)) lines.push(`внимание: этот ролик на ${x.channel} стоит на ${x.date} ${x.time}, не позже премьеры на YouTube. Переставьте: npm run queue -- move ${x.name} --channel=${x.channel} --next`);
        return { code: 0, lines };
      }
      case "cancel": {
        const e = find(args.ref, args.channel);
        const done = await transition(e.id, "cancelled", { note: args.reason || "снята оператором" }, actor);
        lines.push(`снята: ${row(done)}`);
        if (e.status === "handed") lines.push("пакет уже ушёл сотруднику в тему «Выложить руками»: предупредите его, что выкладывать не нужно. Выложенное программа не снимет");
        const yt = await syncYoutube(done.id);
        if (yt) lines.push(yt);
        return { code: 0, lines };
      }
      case "extra": {
        // Служебные поля записи (номер ролика на YouTube, номер загрузки). Содержимое,
        // которое согласовывал человек, они не меняют, поэтому согласие сохраняется.
        const e = find(args.ref, args.channel);
        const saved = await patch(e.id, { extra: { ...(e.extra || {}), ...(args.fields || {}) } }, actor);
        lines.push(`дописано (${Object.keys(args.fields || {}).join(", ")}): ${row(saved)}`);
        return { code: 0, lines, data: withoutIds(saved) };
      }
      case "slots": {
        // Ближайшие свободные слоты по рабочей сетке. --kind=video покажет строку сетки для видео.
        const names = args.channel ? [args.channel] : channelNames();
        for (const n of names) {
          const taken = all().filter((x) => x.channel === n);
          const out = [];
          let after = Date.now();
          for (let i = 0; i < (Number(args.count) || 5); i++) {
            const s = nextSlot(channelCfg(n), taken, after, "", String(args.kind || ""));
            if (!s) break;
            out.push(`${s.date} ${s.time}`);
            taken.push({ id: `tmp${i}`, ...s, status: "approved" });
            after = dueAt(s);
          }
          lines.push(`${n}: ${out.join(", ") || "свободных слотов нет"}`);
        }
        return { code: 0, lines };
      }
      case "export": {
        // Снимок для компьютера оператора. Персональных данных в нём нет: см. snapshot.mjs.
        const { snapshot } = await import("./snapshot.mjs");
        return { code: 0, lines: [], data: snapshot() };
      }
      case "keys": {
        // Отпечатки ключей сервера для сверки копий. По отпечатку значение не восстановить.
        const { fingerprints } = await import("../tokens/check.mjs");
        return { code: 0, lines: [], data: fingerprints() };
      }
      case "comments": {
        // Комментарии под публикациями: список по статусу либо отметка «отвечать не нужно».
        const api = await import("../comments/collect.mjs");
        if (args.ref && args.status) {
          const ok = api.setStatus(args.ref, String(args.status), actor);
          lines.push(ok ? `комментарий ${args.ref}: ${args.status}` : `комментария ${args.ref} нет`);
          return { code: ok ? 0 : 1, lines };
        }
        // Клиент запретил отдавать текст комментариев с сервера: это отказ по правилу.
        const { config } = await import("../lib/config.mjs");
        if (config().privacy?.shareComments === false) {
          return { code: 1, lines: ["текст комментариев с сервера не отдаётся: так решено в zavod.config.json (privacy.shareComments). Сводка приходит сотрудникам в рабочую группу, отвечают они сами"] };
        }
        // Ответ уходит на компьютер оператора: текст отдаём с той же чисткой, что и в снимке.
        // Телефон, который человек сам написал под роликом, с сервера не уезжает.
        const { publicComments } = await import("./snapshot.mjs");
        const found = publicComments(api.byStatus(String(args.status || "new")).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, Number(args.count) || 40));
        if (!found.length) lines.push("комментариев с таким статусом нет");
        // Текст целиком (в снимке он уже обрезан до 600 знаков): ответ пишется по нему, и
        // хвост вопроса, которого сессия не увидела, даёт ответ не о том.
        for (const c of found) lines.push(`${c.id}  ${String(c.at).slice(0, 10)}  ${c.platform}\n  «${String(c.text).replace(/\s+/g, " ")}»\n  ${c.link}`);
        return { code: 0, lines, data: found };
      }
      case "news": {
        // Ящик новостей: список по статусу либо отметка «использована» после постановки материала.
        const inboxApi = await import("../news/inbox.mjs");
        if (args.ref && args.status) {
          const ok = inboxApi.setStatus(args.ref, String(args.status), actor);
          lines.push(ok ? `новость ${args.ref}: ${args.status}` : `новости ${args.ref} в ящике нет`);
          return { code: ok ? 0 : 1, lines };
        }
        const found = inboxApi.byStatus(String(args.status || "taken")).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, Number(args.count) || 30);
        if (!found.length) lines.push("в ящике с таким статусом пусто");
        for (const i of found) lines.push(`${i.id}  ${String(i.published || i.at).slice(0, 10)}  ${i.sourceTitle || i.source}\n  ${i.title}\n  ${i.url}`);
        return { code: 0, lines, data: found };
      }
      case "pause": {
        // Рубильник. Остановок две: человек сказал «стоп» либо расписание перехватывает
        // компьютер оператора (takeover). Вторую снимает только возврат расписания.
        setStop({ by: actor, reason: String(args.reason || ""), takeover: Boolean(args.takeover) });
        if (args.takeover) {
          lines.push("выпуск на сервере остановлен ради перехвата. Включит его возврат: npm run mirror -- --handback");
          // Сроки роликов YouTube не трогаем: сервер уступил расписание, а «не выпускать» никто не говорил.
        } else {
          lines.push("выпуск на сервере остановлен (файл STOP). Включить: npm run queue -- resume");
          lines.push(...await youtubeAfterSwitch());
        }
        return { code: 0, lines };
      }
      case "resume": {
        // Остановку ради перехвата снимает только возврат (он передаёт handback): иначе
        // сервер и компьютер оператора выпускали бы одно и то же.
        if (stopState().takeover && !args.handback) {
          return { code: 1, lines: ["выпуск остановлен ради перехвата расписания компьютером оператора. Включает его возврат: npm run mirror -- --handback. Иначе выпускающих станет двое"] };
        }
        clearStop();
        resolveAlert("release:stop");
        resolveAlert("release:hold");
        lines.push("выпуск на сервере включён");
        lines.push(...await youtubeAfterSwitch());
        return { code: 0, lines };
      }
      case "mark": {
        // Запись вышла не через сервер (перехват расписания, ручная выкладка): сообщаем
        // серверу, иначе он выпустит её второй раз.
        const e = find(args.ref, args.channel);
        const at = args.at || new Date().toISOString();
        if (args.handed) {
          // Пакет на ручную выкладку ушёл в группу с компьютера оператора: публикации ещё нет.
          const handed = await forceHanded(e.id, { result: { ...(e.result || {}), manual: "пакет отправлен, ждёт ручной выкладки", ...(args.packageMessageId ? { packageMessageId: args.packageMessageId } : {}) }, handedAt: at, note: args.note || "пакет отправлен не через сервер" }, actor);
          record(handed, "handed", { at, by: actor });
          lines.push(`отмечена переданной на ручную выкладку: ${row(handed)}`);
          return { code: 0, lines, data: withoutIds(handed) };
        }
        /* Возврат расписания после перехвата. Запись вышла с компьютера оператора, а на
           сервере согласия на ней уже нет: утверждающий снял её либо отозвал «да» после
           последней копии, и компьютер об этом не знал. Отметить её вышедшей по правилам
           нельзя, промолчать тоже: возврат застрял бы навсегда, а запись, ждущая «да»,
           после согласования вышла бы второй раз. Поэтому факт пишется в журнал, запись
           закрывается, а человек клиента узнаёт об этом сразу. */
        if (args.takeover && ["review", "rework", "draft", "cancelled"].includes(e.status)) {
          const was = STATUS_TITLE[e.status] || e.status;
          if (e.status !== "cancelled") await transition(e.id, "cancelled", { note: `вышла с компьютера оператора при перехвате расписания, когда запись была «${was}»`, result: { ...(e.result || {}), id: args.externalId || "", link: args.link || "" } }, actor);
          record(e, "published", { externalId: args.externalId || "", link: args.link || "", at, by: actor, withoutApproval: true });
          await alert(`stray:${e.id}`, `<b>${h(channelCfg(e.channel).title)}</b>: «${h(e.name)}» вышла во время аварии сервера, хотя на сервере она была «${h(was)}». Расписание вёл компьютер оператора по копии, снятой до этого решения.${args.link ? `\n${h(args.link)}` : ""}`, { action: "откройте публикацию. Если она должна быть убрана, её удаляет владелец аккаунта на самой площадке" });
          lines.push(`вышла без согласия: ${e.channel} · ${e.name} (на сервере была «${was}»). В рабочую группу ушло сообщение, запись закрыта`);
          return { code: 0, lines };
        }
        const done = await forcePublished(e.id, { result: { ...(e.result || {}), id: args.externalId || "", link: args.link || "" }, publishedAt: at, note: args.note || "вышла не через сервер" }, actor);
        record(done, "published", { externalId: args.externalId || "", link: args.link || "", at, by: actor });
        lines.push(`отмечена вышедшей: ${row(done)}`);
        return { code: 0, lines, data: withoutIds(done) };
      }
      default:
        return { code: 1, lines: [`команды «${cmd}» нет. Есть: add, list, show, check, submit, inbox, move, cancel, extra, slots, news, comments, export, keys, pause, resume, mark`] };
    }
  } catch (e) {
    return { code: e.code === "RULE" ? 1 : 2, lines: [...lines, e.message || String(e)] };
  }
}
