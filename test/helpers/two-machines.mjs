// Две машины в одном процессе: сервер и компьютер оператора.
//
// У каждой свой каталог данных. «Сеть» между ними — подменённый fetch, который исполняет
// команду очереди в каталоге сервера. Так проверяется главное правило перехвата: выпускает
// всегда кто-то один, а слово человека доходит до обеих машин. fresh() заводит новую пару
// каталогов: каждый тест начинает с чистых машин.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dirs = { server: "", pc: "", mirror: "" };
process.env.ZAVOD_ENV_FILE = path.join(os.tmpdir(), "zavod-нет-такого.env");
process.env.TG_BOT_TOKEN = "test-token";
process.env.TG_GROUP_ID = "-1001";
process.env.APPROVER_IDS = "42";
process.env.ADMIN_API_TOKEN = "ключ-оператора";
delete process.env.TG_RELAY_URL;
delete process.env.TG_CHANNEL;

export const API = "https://zavod.test";
export const serverDir = () => dirs.server;
export const pcDir = () => dirs.pc;
export const mirrorDir = () => dirs.mirror;
export const onServer = () => { process.env.DATA_DIR = dirs.server; delete process.env.QUEUE_API_BASE; };
export const onPc = () => { process.env.DATA_DIR = dirs.pc; process.env.QUEUE_API_BASE = API; };
export const asServer = async (fn) => { onServer(); try { return await fn(); } finally { onPc(); } };
export const asPc = (fn) => { onPc(); return fn(); };

/* Сеть. mode: up — сервер отвечает; down — молчит; 401 — отвечает отказом; 502 — веб-сервер
   жив, а завод за ним нет. budget — сколько запросов к серверу пройдёт до обрыва.
   hook(cmd, args) может вернуть "drop-request" (до сервера не дошло) либо "drop-response"
   (сервер исполнил, ответ потерялся). log — команды, ушедшие на сервер. */
export const net = { mode: "up", budget: Infinity, hook: null, log: [] };
export const sent = [];
export const calls = [];
export const plan = {};

/** Новая пара машин: пустые каталоги, сеть в порядке, журналы вызовов чистые. */
export function fresh() {
  dirs.server = mkdtempSync(path.join(os.tmpdir(), "zavod-srv-"));
  dirs.pc = mkdtempSync(path.join(os.tmpdir(), "zavod-pc-"));
  dirs.mirror = mkdtempSync(path.join(os.tmpdir(), "zavod-mirror-"));
  process.env.MIRROR_DIR = dirs.mirror;
  Object.assign(net, { mode: "up", budget: Infinity, hook: null });
  net.log.length = 0;
  sent.length = 0;
  calls.length = 0;
  for (const k of Object.keys(plan)) delete plan[k];
  onServer();
}
fresh();

export const store = await import("../../src/queue/store.mjs");
export const ledger = await import("../../src/queue/ledger.mjs");
export const { execute } = await import("../../src/queue/commands.mjs");
export const { runOnce } = await import("../../src/queue/runner.mjs");
export const mirror = await import("../../src/queue/mirror.mjs");
export const sw = await import("../../src/queue/switch.mjs");
export const approval = await import("../../src/bot/approval.mjs");
export const staff = await import("../../src/bot/staff.mjs");
const channels = await import("../../src/channels/index.mjs");
const timeLib = await import("../../src/lib/time.mjs");

let messageId = 900;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith(API)) {
    if (net.mode === "down" || net.budget <= 0) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    net.budget--;
    if (net.mode === "502") return new Response("<html>502 Bad Gateway</html>", { status: 502 });
    if (net.mode === "401") return new Response(JSON.stringify({ code: 2, lines: ["ключ оператора не подошёл"] }), { status: 401 });
    const payload = JSON.parse(init.body);
    const verdict = net.hook ? net.hook(payload.cmd, payload.args || {}) : undefined;
    const a = payload.args || {};
    net.log.push(`${payload.cmd}${a.takeover ? "(takeover)" : ""}${a.ongoing ? "(ongoing)" : ""}${a.handback ? "(handback)" : ""}${a.partial ? "(partial)" : ""}${a.handed ? "(handed)" : ""}`);
    if (verdict === "drop-request") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    const out = await asServer(async () => execute(payload.cmd, a, payload.actor));
    if (verdict === "drop-response") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } });
    return new Response(JSON.stringify(out), { status: 200 });
  }
  const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : {};
  sent.push({ method: u.split("/").pop(), body });
  return new Response(JSON.stringify({ ok: true, result: { message_id: ++messageId, chat: { id: -1001 } } }), { status: 200 });
};
export const said = () => sent.map((s) => s.body.text || "").join("\n");

/* Площадки-заглушки: каждый вызов пишется в calls с тем, где он исполнен. plan[имя]
   задаёт особое поведение записи; по умолчанию она выходит с первого раза. */
const where = () => (process.env.DATA_DIR === dirs.pc ? "компьютер" : "сервер");
const ok = (entry) => ({ ok: true, id: `id-${entry.name}`, link: `https://www.threads.net/@eco/post/${entry.name}`, done: [`id-${entry.name}`] });
channels._setAdapter("threads", { name: "threads", publish: async (entry, ctx) => { calls.push({ name: entry.name, where: where(), done: [...(entry.done || [])], first: (entry.posts || [])[0], verify: Boolean(ctx?.verify) }); return (plan[entry.name] || ok)(entry, ctx); } });
channels._setAdapter("vk", { name: "vk", publish: async (entry, ctx) => { calls.push({ name: entry.name, where: where() }); return (plan[entry.name] || ((e) => ({ ok: true, id: `vk-${e.name}`, link: `https://vk.com/wall-1_${e.name}` })))(entry, ctx); } });
channels._setAdapter("dzen", { name: "dzen", publish: async (entry, ctx) => { calls.push({ name: entry.name, where: where() }); await ctx.onState({ packageMessageId: 7100 }); return { ok: true, manual: true, note: "пакет отправлен в группу" }; } });

export const withFlags = async (flags, fn) => {
  const add = flags.map((f) => `--${f}`);
  process.argv.push(...add);
  try { return await fn(); } finally { for (const a of add) process.argv.splice(process.argv.indexOf(a), 1); }
};
export const press = (data, messageId) => {const e=store.get(data.split(':')[2]),token=e?.approval?.actionToken;return approval.handleCallback({ id:'cb',data:token?data+':'+token:data,from:{id:42,first_name:'Анна'},message:{message_id:messageId||e?.approval?.card?.messageId,chat:{id:-1001}}});};
export const command = (text) => staff.handleCommand({ text, chat: { id: -1001 }, from: { id: 42, first_name: "Анна" } });
export const thread = (name, date, time, posts) => ({ channel: "threads", kind: "thread", name, material: "blog:primer", date, time, posts: posts || [`«${name}»: подрядчик в Казани сдал площадку, а через год она крошится.`, "Причина нашлась в акте: толщину никто не мерил."] });
/** Поставить, отправить на согласование и одобрить: запись стоит в расписании. */
export const approved = async (raw) => {
  const { entry } = await store.put(raw, "S1");
  await approval.submit(entry.id, "S1");
  await press(`q:ok:${entry.id}`);
  return store.get(entry.id);
};
export const local = (id) => asPc(() => store.get(id));
export const remote = (id) => { onServer(); try { return store.get(id); } finally { onPc(); } };
export const T = (date, time, min = 0) => timeLib.dueAt({ date, time }) + min * 60_000;
export { existsSync, readFileSync, writeFileSync, path };
