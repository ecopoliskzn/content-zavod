// Команды очереди. Одна реализация на два входа: командная строка на сервере и ручка
// /admin/queue, через которую с очередью работает компьютер оператора.
//
// КОДЫ ВЫХОДА — РАЗНЫЕ ВЕЩИ, смешивать нельзя:
//   0 — сделано;
//   1 — отказ ПО ПРАВИЛУ: проверки не пройдены, переход запрещён. Это ответ человеку;
//   2 — поломка окружения: нет ключа, сеть, не читается файл. Это чинится.
// Смешаете — оператор побежит чинить сервер там, где ему просто отказали.

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { channel as channelCfg, channelNames } from "../lib/config.mjs";
import { dataPath } from "../lib/env.mjs";
import { dueAt, human, mskDate, mskTime } from "../lib/time.mjs";
import { check } from "../gates/index.mjs";
import { inbox, submit } from "../bot/approval.mjs";
import { STATUS_TITLE, normalize, preview, validate } from "./format.mjs";
import { record } from "./ledger.mjs";
import { nextSlot, slotTaken } from "./slots.mjs";
import { all, forcePublished, get, history, patch, put, reschedule, transition } from "./store.mjs";

const byDue = (a, b) => dueAt(a) - dueAt(b);

/** Найти запись по номеру или по имени (имя уникально в пределах площадки). */
function find(ref, channel) {
  const direct = get(ref);
  if (direct) return direct;
  const named = all().filter((e) => e.name === ref && (!channel || e.channel === channel));
  if (named.length === 1) return named[0];
  if (named.length > 1) throw Object.assign(new Error(`имя «${ref}» есть на нескольких площадках: уточните --channel`), { code: "RULE" });
  throw Object.assign(new Error(`записи «${ref}» в очереди нет`), { code: "RULE" });
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
          if (!e.date || !e.time) {
            const slot = nextSlot(channelCfg(e.channel), all().filter((x) => x.channel === e.channel), Date.now(), e.id);
            if (!slot) throw Object.assign(new Error(`у площадки ${e.channel} нет свободных слотов на месяц вперёд`), { code: "RULE" });
            Object.assign(e, slot);
          } else if (slotTaken(all().filter((x) => x.channel === e.channel), e.date, e.time, e.id)) {
            lines.push(`внимание: слот ${e.date} ${e.time} на ${e.channel} уже занят другой записью`);
          }
          const { entry, result } = await put(e, actor);
          const verdict = check(entry);
          lines.push(`${result}: ${row(entry)}`);
          for (const b of verdict.block) lines.push(`  ⛔ ${b}`);
          for (const w of verdict.warn) lines.push(`  ⚠ ${w}`);
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
        return { code: 0, lines, data: found };
      }
      case "show": {
        const e = find(args.ref, args.channel);
        lines.push(row(e), "");
        if (e.kind === "thread") e.posts.forEach((p, i) => lines.push(`— ${i + 1} —`, p, ""));
        else lines.push(e.title ? `# ${e.title}\n` : "", e.text || "");
        if (e.note) lines.push(`заметка: ${e.note}`);
        if (e.result?.link) lines.push(`ссылка: ${e.result.link}`);
        if (e.approval?.name) lines.push(`одобрил(а): ${e.approval.name}, ${e.approval.at}`);
        if (args.history) for (const h of history(e.id)) lines.push(`  ${h.at} ${h.by} → ${h.status}`);
        return { code: 0, lines, data: e };
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
        const targets = args.ref ? [find(args.ref, args.channel)] : all().filter((e) => e.status === "draft" && (!args.channel || e.channel === args.channel));
        if (!targets.length) lines.push("черновиков нет");
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
          const slot = nextSlot(channelCfg(e.channel), all().filter((x) => x.channel === e.channel), Date.now(), e.id);
          if (!slot) throw Object.assign(new Error("свободных слотов нет"), { code: "RULE" });
          ({ date, time } = slot);
        }
        const moved = await reschedule(e.id, date, time, actor);
        lines.push(`переставлена на ${human(moved)}: ${row(moved)}`);
        return { code: 0, lines };
      }
      case "cancel": {
        const e = find(args.ref, args.channel);
        const done = await transition(e.id, "cancelled", { note: args.reason || "снята оператором" }, actor);
        lines.push(`снята: ${row(done)}`);
        return { code: 0, lines };
      }
      case "extra": {
        // Служебные поля записи (номер ролика на YouTube, номер загрузки). Содержимое,
        // которое согласовывал человек, они не меняют, поэтому согласие сохраняется.
        const e = find(args.ref, args.channel);
        const saved = await patch(e.id, { extra: { ...(e.extra || {}), ...(args.fields || {}) } }, actor);
        lines.push(`дописано (${Object.keys(args.fields || {}).join(", ")}): ${row(saved)}`);
        return { code: 0, lines, data: saved };
      }
      case "slots": {
        const names = args.channel ? [args.channel] : channelNames();
        for (const n of names) {
          const taken = all().filter((x) => x.channel === n);
          const out = [];
          let after = Date.now();
          for (let i = 0; i < (Number(args.count) || 5); i++) {
            const s = nextSlot(channelCfg(n), taken, after);
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
        // Ответ уходит на компьютер оператора: текст отдаём с той же чисткой, что и в снимке.
        // Телефон, который человек сам написал под роликом, с сервера не уезжает.
        const { publicComments } = await import("./snapshot.mjs");
        const found = publicComments(api.byStatus(String(args.status || "new")).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, Number(args.count) || 40));
        if (!found.length) lines.push("комментариев с таким статусом нет");
        for (const c of found) lines.push(`${c.id}  ${String(c.at).slice(0, 10)}  ${c.platform}\n  «${String(c.text).replace(/\s+/g, " ").slice(0, 200)}»\n  ${c.link}`);
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
        // Рубильник: перед перехватом расписания компьютером оператора сервер обязан замолчать.
        writeFileSync(dataPath("STOP"), `остановил ${actor} ${new Date().toISOString()}${args.reason ? `: ${args.reason}` : ""}`, "utf8");
        lines.push("выпуск на сервере остановлен (файл STOP). Включить: npm run queue -- resume");
        return { code: 0, lines };
      }
      case "resume": {
        for (const f of ["STOP", "HOLD"]) if (existsSync(dataPath(f))) rmSync(dataPath(f));
        lines.push("выпуск на сервере включён");
        return { code: 0, lines };
      }
      case "mark": {
        // Запись вышла не через сервер (перехват расписания, ручная выкладка): сообщаем
        // серверу, иначе он выпустит её второй раз.
        const e = find(args.ref, args.channel);
        const at = args.at || new Date().toISOString();
        const done = await forcePublished(e.id, { result: { ...(e.result || {}), id: args.externalId || "", link: args.link || "" }, publishedAt: at, note: args.note || "вышла не через сервер" }, actor);
        record(done, "published", { externalId: args.externalId || "", link: args.link || "", at, by: actor });
        lines.push(`отмечена вышедшей: ${row(done)}`);
        return { code: 0, lines, data: done };
      }
      default:
        return { code: 1, lines: [`команды «${cmd}» нет. Есть: add, list, show, check, submit, inbox, move, cancel, extra, slots, news, comments, export, keys, pause, resume, mark`] };
    }
  } catch (e) {
    return { code: e.code === "RULE" ? 1 : 2, lines: [...lines, e.message || String(e)] };
  }
}
