// Команды очереди на сервере с компьютера оператора: один вход для дубля расписания,
// перехвата и сверки во время перехвата.
//
// ДВА РАЗНЫХ «НЕ ПОЛУЧИЛОСЬ». До сервера не дошло (network) и сервер ответил отказом
// (refused) требуют разных действий. Устаревший ключ оператора даёт отказ 401: назвать
// это «сервер не ответил» значит отправить оператора перехватывать расписание у
// сервера, который жив и выпускает сам.
//
// К «не дошло» относится и ответ 502–504: веб-сервер жив, а процесс завода за ним нет.
// Выпуск по расписанию при этом может идти: его зовёт cron, а не этот процесс.

import { env } from "../lib/env.mjs";
import { request } from "../lib/http.mjs";

export const base = () => env("QUEUE_API_BASE").replace(/\/+$/, "");

const KEY_HINT = "ключ оператора (ADMIN_API_TOKEN) на этом компьютере не совпадает с серверным либо адрес сервера указан не тот. Как перенести ключ заново: docs/04-ДОСТУПЫ-ПО-ПЛОЩАДКАМ.md, раздел 9 «Ключ оператора»";

/**
 * @param {string} cmd команда очереди
 * @param {object} args её аргументы
 * @returns {Promise<{ code: number, lines: string[], data?: any, network?: boolean, refused?: boolean }>}
 *   network — до завода на сервере не дошло; refused — сервер ответил, но команду не принял (ключ, адрес)
 */
export async function server(cmd, args = {}, timeoutMs = 30_000) {
  if (!base()) return { code: 2, lines: ["нет QUEUE_API_BASE: адрес сервера не задан"], refused: true };
  const res = await request(`${base()}/admin/queue`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env("ADMIN_API_TOKEN")}` },
    body: JSON.stringify({ cmd, args, actor: `${env("OPERATOR_NAME", "оператор")} (дубль)` }),
    timeoutMs,
  });
  // Ответ самой команды: и «сделано», и отказ по правилу приходят с кодом 200.
  if (res.kind === "ok" && res.data && Array.isArray(res.data.lines)) return res.data;
  if (res.kind === "network") return { code: 2, lines: [`сервер не ответил: ${res.error}`], network: true };
  const said = res.data && Array.isArray(res.data.lines) ? res.data.lines : [`сервер ответил отказом (${res.status || "без кода"}): ${res.error}`];
  return { code: 2, lines: [...said, KEY_HINT], refused: true };
}
