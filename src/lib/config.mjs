// Реестр завода: zavod.config.json. Читают очередь, выпуск, проверки и сборщик витрины.
import path from "node:path";
import { PROJECT_ROOT } from "./env.mjs";
import { readJson } from "./files.mjs";

let cache = null;

export function config() {
  if (!cache) {
    cache = readJson(path.join(PROJECT_ROOT, "zavod.config.json"));
    if (!cache) throw Object.assign(new Error("не прочитан zavod.config.json в корне проекта"), { code: "ENV" });
  }
  return cache;
}

export function channel(name) {
  const c = config().channels?.[name];
  if (!c) throw Object.assign(new Error(`площадки «${name}» нет в zavod.config.json`), { code: "RULE" });
  return { name, ...c };
}

export const channelNames = () => Object.keys(config().channels || {});

/** Площадка с ограниченным доступом: там действует запрет рекламы, проверка строже. */
export const isRestricted = (name) => channel(name).access === "restricted";

/** Для тестов. */
export function _setConfig(value) {
  cache = value;
}
