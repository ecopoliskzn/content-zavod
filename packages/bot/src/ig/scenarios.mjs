// Загрузка сценариев кодовых слов: источник задаётся конфигом инстанса, а не
// зашитым путём. kormishin держал сценарии в lib/ig/scenarios/*.json — здесь тот
// же формат файлов, но директория (или готовый массив) приходит извне.

import fs from "node:fs";
import path from "node:path";

/**
 * @param {string[] | object[] | string} источник
 *   - массив уже разобранных сценариев — используется как есть;
 *   - строка — путь к директории с *.json, каждый файл содержит один сценарий
 *     или массив сценариев.
 * @returns {object[]}
 */
export function загрузитьСценарии(источник) {
  if (Array.isArray(источник)) return источник;
  if (typeof источник !== "string") {
    throw new TypeError("scenarios: ожидался массив сценариев или путь к директории");
  }
  if (!fs.existsSync(источник)) return [];
  const файлы = fs
    .readdirSync(источник)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const сценарии = [];
  for (const файл of файлы) {
    const сырое = JSON.parse(fs.readFileSync(path.join(источник, файл), "utf8"));
    if (Array.isArray(сырое)) сценарии.push(...сырое);
    else сценарии.push(сырое);
  }
  return сценарии.filter((с) => с.включён !== false);
}
