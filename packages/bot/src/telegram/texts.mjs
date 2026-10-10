// Минимальная texts-API: инстанс поставляет объект текстов (не kormishin), пакет
// только умеет по нему ходить и подставлять плейсхолдеры — тем же движком, что и
// ig/match.mjs (подставить), чтобы правило "{имя}" было одно на IG и на TG.

import { подставить } from "../ig/match.mjs";

/**
 * @param {Record<string, string | ((ctx: object) => string)>} texts плоский или
 *   вложенный (через точку в ключе) словарь текстов инстанса
 */
export function createTexts(texts = {}) {
  function get(key) {
    if (key in texts) return texts[key];
    // поддержка "a.b.c" для вложенных словарей
    return key.split(".").reduce((acc, k) => (acc && typeof acc === "object" ? acc[k] : undefined), texts);
  }

  /**
   * Возвращает готовый текст: функция вызывается с values, строка — прогоняется
   * через подставить({плейсхолдеры}).
   */
  function render(key, values = {}) {
    const raw = get(key);
    if (raw === undefined) return undefined;
    if (typeof raw === "function") return raw(values);
    return подставить(raw, values);
  }

  return { get, render, raw: texts };
}
