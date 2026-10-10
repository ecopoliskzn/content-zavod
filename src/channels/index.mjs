// Реестр площадок. У каждой площадки один файл с одним договором:
//
//   export const name                    имя площадки, как в zavod.config.json
//   export async function publish(entry, ctx)
//       → { ok: true, id, link, done? }               вышло
//       → { ok: true, manual: true, note }            ушёл пакет на ручную выкладку
//       → { ok: false, error, retry, done?, link? }   не вышло; retry — повтор имеет смысл
//   export async function metrics(items)  цифры по номерам публикаций (необязательно)
//   export async function probe()         живая проверка связи и ключа для doctor
//
// Адаптер НЕ решает, когда выпускать, сколько раз пробовать и кого звать при сбое:
// это делает выпуск (src/queue/runner.mjs). Адаптер знает только свою площадку и её
// грабли, и они записаны в шапке его файла.

const FILES = {
  threads: "./threads.mjs",
  telegram: "./telegram.mjs",
  vk: "./vk.mjs",
  dzen: "./dzen.mjs",
  instagram: "./instagram.mjs",
  youtube: "./youtube.mjs",
  rutube: "./rutube.mjs",
  bot: "./bot.mjs",
};

const cache = new Map();

export async function adapter(name) {
  if (!FILES[name]) throw Object.assign(new Error(`площадки «${name}» нет в реестре адаптеров`), { code: "RULE" });
  if (!cache.has(name)) cache.set(name, await import(FILES[name]));
  return cache.get(name);
}

export const adapterNames = () => Object.keys(FILES);

/** Для тестов: подменить адаптер заглушкой. */
export function _setAdapter(name, mod) {
  cache.set(name, mod);
}
