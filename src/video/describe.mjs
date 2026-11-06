// Описание ролика для площадки: согласованный текст плюс блок ссылок. Обвязка над чистой
// сборкой из series.mjs: читает адрес завода, имя бота, строку о компании и короткие ссылки.
// Одна функция на все места, где описание уходит наружу: загрузка на YouTube, вызов
// Rutube, запись ВКонтакте и пакет на ручную выкладку. Иначе у пакета и у программной
// загрузки описания разойдутся.

import path from "node:path";
import { config } from "../lib/config.mjs";
import { PROJECT_ROOT, env } from "../lib/env.mjs";
import { readJson } from "../lib/files.mjs";
import { composeDescription, pinnedComment } from "./series.mjs";

export function describeContext(extra = {}) {
  const registry=readJson(path.join(PROJECT_ROOT,'content','youtube','series.json'),{series:[]})||{series:[]};
  const snapshot=readJson(path.join(PROJECT_ROOT,'content','youtube','channel.json'),{list:[]})||{list:[]};
  const titles=Object.fromEntries((snapshot.list||[]).map(v=>[v.id,v.title]));
  for(const series of registry.series||[])for(const v of series.videos||[])if(v.id&&v.title)titles[v.id]=v.title;
  return {
    registry,titles,
    base: env("PUBLIC_BASE_URL"),
    bot: env("TG_BOT_USERNAME"),
    about: config().client.about || "",
    links: readJson(path.join(PROJECT_ROOT, "bot", "links.json"), {}) || {},
    ...extra,
  };
}

/** Полное описание ролика под площадку записи. */
export const describe = (entry, extra = {}) => composeDescription(entry, describeContext({ platform: entry.channel, ...extra }));

/** Текст закреплённого комментария под ролик. */
export const pinText = (entry, extra = {}) => pinnedComment(entry, describeContext({ platform: entry.channel, ...extra }));
