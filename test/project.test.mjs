// Проект цел: образцы проходят собственные проверки, ссылки в документах ведут на
// существующие файлы, образец окружения совпадает с реестром, расписание зовёт то, что есть.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "zavod-project-"));
process.env.ZAVOD_ENV_FILE = path.join(process.env.DATA_DIR, "нет-такого.env");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(path.join(ROOT, ...p), "utf8");
const json = (...p) => JSON.parse(read(...p));
const { normalize, validate } = await import("../src/queue/format.mjs");
const { checkAll } = await import("../src/gates/rules.mjs");
const { codeWords } = await import("../src/gates/index.mjs");
const { example } = await import("../src/tokens/check.mjs");
const { MARK, botLink, goLink, goLinksIn, postMark } = await import("../src/leads/marks.mjs");

const config = json("zavod.config.json");
const links = Object.keys(json("bot", "links.json"));
const stamps = json("src", "gates", "stamps.json").phrases;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", "data", "mirror", "vault", "reference"].includes(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/* ───────────────────────────── метки и ссылки ───────────────────────────── */

test("метка есть у каждой площадки реестра, ссылки собираются одинаково", () => {
  for (const name of Object.keys(config.channels)) assert.ok(MARK[name], `у площадки ${name} нет метки для ссылок`);
  assert.equal(new Set(Object.values(MARK)).size, Object.values(MARK).length, "метки не повторяются");
  assert.equal(goLink("https://go.example.ru/", "priemka", "threads", "vyrubki-14-tochek"), "https://go.example.ru/go/priemka?c=th&p=vyrubki-14-tochek");
  assert.equal(goLink("https://go.example.ru", "priemka", "youtube"), "https://go.example.ru/go/priemka?c=yt");
  assert.equal(botLink("@eco_bot", "vk", "rashod"), "https://t.me/eco_bot?start=vk-rashod");
  assert.equal(postMark("Вырубки: 14 точек!"), "14");
  assert.deepEqual(goLinksIn("см. https://go.example.ru/go/Priemka2?c=th&p=x) и /go/klej"), [{ slug: "priemka2", c: "th", p: "x", raw: "/go/Priemka2?c=th&p=x" }, { slug: "klej", c: "", p: "", raw: "/go/klej" }]);
});

test("проверка ссылок: неизвестный слаг останавливает, чужая метка — замечание", () => {
  const entry = (posts, over = {}) => ({ channel: "threads", kind: "thread", name: "x", posts, ...over });
  const ctx = { links: ["priemka"] };
  const unknown = checkAll(entry(["Площадку в Казани приняли за пять минут.", "Чек-лист: https://go.example.ru/go/priemkaa?c=th&p=x"]), ctx);
  assert.ok(unknown.block.some((b) => /^готовность: .*слага «priemkaa» нет/.test(b)));
  const foreign = checkAll(entry(["Площадку в Казани приняли за пять минут.", "Чек-лист: https://go.example.ru/go/priemka?c=vk&p=x"]), ctx);
  assert.deepEqual(foreign.block, []);
  assert.ok(foreign.warn.some((w) => /метка площадки «vk», а запись выходит на threads/.test(w)));
  const bare = checkAll(entry(["Площадку в Казани приняли за пять минут.", "Чек-лист: https://go.example.ru/go/priemka"]), ctx);
  assert.ok(bare.warn.some((w) => /нет метки площадки/.test(w)));
  const fine = checkAll(entry(["Площадку в Казани приняли за пять минут.", "Чек-лист: https://go.example.ru/go/priemka?c=th&p=x"]), ctx);
  assert.ok(!fine.warn.some((w) => /^готовность:/.test(w)));
  // Кнопка под постом и поля ролика проверяются так же, как текст.
  const button = checkAll({ channel: "telegram", kind: "post", name: "x", text: "Площадку в Казани приняли за пять минут.", buttons: [[{ text: "Чек-лист", url: "https://go.example.ru/go/net?c=tg" }]] }, ctx);
  assert.ok(button.block.some((b) => /слага «net» нет/.test(b)));
  const video = checkAll({ channel: "youtube", kind: "short", name: "x", title: "Прораб положил покрытие в дождь", text: "Что стало с площадкой.", goSlug: "nety", hashtags: ["а"] }, ctx);
  assert.ok(video.block.some((b) => /поле goSlug = «nety»/.test(b)));
  // Рассылка в боте ведёт по ссылке с меткой «bot-…»: это своя метка, а не чужая.
  const bot = checkAll({ channel: "bot", kind: "post", name: "x", text: "Материал: https://go.example.ru/go/priemka?c=bot-vk" }, ctx);
  assert.ok(!bot.warn.some((w) => /не той площадке/.test(w)));
});

/* ───────────────────────────── образцы записей ───────────────────────────── */

const SAMPLES = path.join(ROOT, "prompts", "samples", "entries");
const sampleFiles = existsSync(SAMPLES) ? readdirSync(SAMPLES).filter((f) => f.endsWith(".json")) : [];

test("образцы записей есть для каждой площадки и для ответа на комментарий", () => {
  const entries = sampleFiles.map((f) => json("prompts", "samples", "entries", f));
  for (const name of Object.keys(config.channels)) assert.ok(entries.some((e) => e.channel === name), `нет образца записи для площадки ${name}`);
  assert.ok(entries.some((e) => e.kind === "reply"), "нет образца ответа на комментарий");
});

for (const file of sampleFiles) {
  test(`образец ${file}: годен по форме и проходит все проверки без замечаний`, () => {
    const raw = json("prompts", "samples", "entries", file);
    const entry = normalize(raw);
    const format = validate(entry).filter((b) => !(b.startsWith("дата и время") && !entry.date && !entry.time));
    assert.deepEqual(format, [], "претензии к форме");
    const verdict = checkAll(entry, { stamps, codeWords: codeWords(), restricted: config.channels[entry.channel].access === "restricted", links, recentOpeners: [] });
    assert.deepEqual(verdict.block, [], "образец не проходит собственные проверки");
    assert.deepEqual(verdict.warn, [], "образец учит писать с замечаниями");
    // Имя записи годится как метка публикации в ссылке.
    assert.equal(postMark(entry.name), entry.name, "имя записи: латиница, цифры и дефис, до 32 знаков");
    // У каждого утверждения есть источник, и он ведёт на сайт клиента.
    for (const f of entry.facts || []) assert.match(String(f.source), /^https:\/\/ecopolisrf\.ru\//, `источник факта «${f.claim}»`);
    // Материал записи существует.
    const [kind, id] = String(entry.material).split(/:(.*)/s);
    if (kind === "blog") assert.ok(existsSync(path.join(ROOT, "content", "articles", `${id}.md`)), `статьи ${id} нет в content/articles`);
    // Метка площадки в ссылках образца совпадает с площадкой.
    for (const l of goLinksIn([entry.text, ...(entry.posts || []), entry.link, ...(entry.buttons || []).flat().map((b) => b.url)].join("\n"))) {
      assert.ok(l.c === MARK[entry.channel] || l.c.startsWith(`${MARK[entry.channel]}-`), `метка «${l.c}» в ссылке образца ${file}`);
      assert.equal(l.p, entry.name, "метка публикации в ссылке равна имени записи");
    }
  });
}

/* ───────────────────────────── окружение и расписание ───────────────────────────── */

test("образец окружения собран из реестра и не разошёлся с ним", () => {
  const titles = Object.fromEntries(Object.entries(config.channels).map(([k, v]) => [k, v.title]));
  assert.equal(read(".env.example").replace(/\r\n/g, "\n"), example(titles), "запустите: npm run tokens -- --example > .env.example");
  assert.doesNotMatch(read(".env.example"), /^[A-Z_]+=.+$/m, "в образце не должно быть значений");
});

test("расписание зовёт существующие файлы, и реестр о них знает", () => {
  const cron = read("ops", "crontab.txt");
  const called = [...cron.matchAll(/\$APP\/([\w./-]+)/g)].map((m) => m[1]);
  assert.ok(called.length >= 10);
  for (const p of called) assert.ok(existsSync(path.join(ROOT, p)), `crontab зовёт несуществующий файл ${p}`);
  for (const job of config.cron) {
    const file = String(job.run).match(/(src|ops)\/[\w./-]+/)?.[0];
    assert.ok(file && existsSync(path.join(ROOT, file)), `задача ${job.id} в реестре зовёт несуществующий файл`);
    if (job.where === "сервер" && !["morning", "digest"].includes(job.id)) assert.ok(cron.includes(file), `задача ${job.id} есть в реестре, но её нет в ops/crontab.txt`);
  }
  for (const [name, c] of Object.entries(config.channels)) assert.ok(existsSync(path.join(ROOT, c.adapter)), `у площадки ${name} нет адаптера ${c.adapter}`);
});

test("скрипты для Linux без переносов Windows, обёртки Windows только латиницей", () => {
  for (const p of ["ops/deploy.sh", "ops/backup.sh", "ops/crontab.txt", "ops/systemd/ecopolis-zavod.service", "ops/systemd/zavod-relay.service", "ops/nginx/zavod.conf", "ops/nginx/relay.conf", "ops/logrotate/zavod"]) {
    assert.ok(!read(...p.split("/")).includes("\r"), `${p}: перенос строки Windows, на сервере файл не сработает`);
  }
  // PowerShell 5.1 читает .ps1 без метки в ANSI: кириллица в нём превращается в мусор.
  assert.match(read("ops", "windows", "install-tasks.ps1"), /^[\x00-\x7F]*$/, "install-tasks.ps1: только латиница");
});

/* ───────────────────────────── документы и промпты ───────────────────────────── */

const DOC_DIRS = ["docs", "prompts", "legal", "ops", ".agents"];
const docFiles = [...DOC_DIRS.flatMap((d) => walk(path.join(ROOT, d))), ...["МАСТЕР-ПРОМПТ.md", "AGENTS.md", "README.md"].map((f) => path.join(ROOT, f))].filter((p) => p.endsWith(".md") && existsSync(p));

test("пути к файлам проекта в документах и промптах ведут на существующие файлы", () => {
  const roots = ["docs", "prompts", "legal", "ops", "src", "bot", "content", "packages", "test", ".agents", ".codex"];
  const missing = [];
  for (const file of docFiles) {
    // Описание правки чужого проекта ссылается на его файлы, а не на наши.
    if (file.includes(`${path.sep}patches${path.sep}`)) continue;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/`([^`\s]+)`/g)) {
      const ref = m[1].replace(/[.,;:)]+$/, "");
      const top = ref.split("/")[0];
      if (!roots.includes(top) || /[<>*{}$…]|\.\.\./.test(ref)) continue;
      // Каталоги данных и снимка появляются при работе завода: их в проекте нет.
      if (/^content\/queue\//.test(ref)) continue;
      const target = path.join(ROOT, ...ref.split("/"));
      if (existsSync(target)) continue;
      // Короткая ссылка на документ по номеру: «legal/05» — это legal/05-СОГЛАСИЯ-….md.
      const dir = path.dirname(target);
      const short = existsSync(dir) && readdirSync(dir).some((name) => name.startsWith(`${path.basename(target)}-`));
      if (!short) missing.push(`${path.relative(ROOT, file)} → ${ref}`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], "ссылки на несуществующие файлы");
});

test("у каждой сессии есть промпт, а общие правила Codex помещаются в предел", () => {
  for (const s of config.sessions) assert.ok(existsSync(path.join(ROOT, ...s.prompt.split("/"))), `нет промпта сессии ${s.id}: ${s.prompt}`);
  assert.ok(existsSync(path.join(ROOT, "МАСТЕР-ПРОМПТ.md")), "нет мастер-промпта");
  const agents = path.join(ROOT, "AGENTS.md");
  assert.ok(existsSync(agents), "нет AGENTS.md");
  // Codex читает правила проекта до 32 КиБ; что не влезло, он молча отбрасывает.
  assert.ok(statSync(agents).size < 32 * 1024, `AGENTS.md занимает ${statSync(agents).size} байт, предел 32768`);
  for (const s of config.sessions) {
    const skill = walk(path.join(ROOT, ".agents", "skills")).find((p) => p.endsWith("SKILL.md") && path.basename(path.dirname(p)).startsWith(`zavod-${s.id.toLowerCase()}`));
    assert.ok(skill, `нет навыка Codex для сессии ${s.id}`);
    assert.ok(readFileSync(skill, "utf8").includes(s.prompt), `навык сессии ${s.id} не ведёт на её промпт`);
  }
});

test("в документах и промптах нет ни одного значения, похожего на ключ", () => {
  const suspicious = /(?:\b\d{8,10}:[A-Za-z0-9_-]{35}\b|\bIG[A-Za-z0-9]{60,}|\bTHAA[A-Za-z0-9]{40,}|\bvk1\.a\.[A-Za-z0-9_-]{40,}|\bAIza[0-9A-Za-z_-]{35}\b|\bya29\.[A-Za-z0-9_-]{20,})/;
  for (const file of [...docFiles, ...walk(path.join(ROOT, "bot")), ...walk(path.join(ROOT, "content", "youtube")), path.join(ROOT, "zavod.config.json"), path.join(ROOT, ".env.example")]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), suspicious, `${path.relative(ROOT, file)}: строка похожа на ключ площадки`);
  }
});
