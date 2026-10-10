// Журнал выпусков: одна строка на «материал × площадка × статус × ссылка».
//
// Только дописывание, без переписывания задним числом. По журналу видно, что куда ушло,
// он же кормит съём цифр и недельный отчёт, и он же спасает от повторной публикации.
// «Принято площадкой» и «вышло» — разные вещи: строка published пишется только после
// ответа площадки с номером публикации или после того, как пост найден на ней.

import { dataPath } from "../lib/env.mjs";
import { appendJsonl, readJsonl } from "../lib/files.mjs";

const FILE = () => dataPath("ledger.jsonl");

export function record(entry, status, extra = {}) {
  return appendJsonl(FILE(), {
    at: new Date().toISOString(),
    id: entry.id,
    channel: entry.channel,
    kind: entry.kind,
    name: entry.name,
    material: entry.material || "",
    slot: `${entry.date} ${entry.time}`,
    status,
    ...extra,
  });
}

export const rows = () => readJsonl(FILE());

/** Вышедшее за период: то, по чему снимаются цифры. */
export function published({ sinceMs = 0, channel } = {}) {
  return rows().filter((r) => r.status === "published" && Date.parse(r.at) >= sinceMs && (!channel || r.channel === channel));
}

/** Когда на площадке что-то выходило в последний раз (мс) и сколько вышло за сутки. */
export function channelLoad(channel, now = Date.now()) {
  const mine = rows().filter((r) => r.channel === channel && r.status === "published");
  const last = mine.reduce((m, r) => Math.max(m, Date.parse(r.at)), 0);
  const dayStart = now - 24 * 3600_000;
  return { last, lastDay: mine.filter((r) => Date.parse(r.at) >= dayStart).length };
}
