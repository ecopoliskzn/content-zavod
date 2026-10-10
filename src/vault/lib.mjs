// Витрина Obsidian: общие кирпичи. Чистые функции, без файлов и сети.
//
// Витрина собирается ИЗ ЖИВОГО СОСТОЯНИЯ завода, а не пишется руками: заметка, которую
// никто не обновляет, через месяц врёт. Поэтому здесь только то, из чего сборщик лепит
// заметки: имена файлов, ссылки, шапки свойств, таблицы, канвы.

/** Имя файла заметки: без знаков, которые не принимает Windows или ломают ссылки Obsidian. */
export function safe(name, max = 90) {
  const s = String(name ?? "")
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "");
  return (s.length > max ? s.slice(0, max).trim() : s) || "без имени";
}

/** Ссылка на заметку по пути от корня хранилища. Путь всегда полный: так ссылка не зависит от тёзок. */
export function link(notePath, alias) {
  const p = String(notePath).replace(/\.md$/, "");
  const shown = alias ?? p.split("/").pop();
  // Вертикальная черта внутри таблицы Markdown делит ячейку: экранируем её в самой ссылке.
  return `[[${p}|${String(shown).replace(/[[\]|]/g, " ").trim()}]]`;
}

/** Та же ссылка для ячейки таблицы. */
export const cellLink = (notePath, alias) => link(notePath, alias).replace("|", "\\|");

const yamlValue = (v) => {
  if (v === null || v === undefined) return '""';
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return `[${v.map((x) => JSON.stringify(String(x))).join(", ")}]`;
  return JSON.stringify(String(v));
};

/** Шапка свойств заметки. Пустые значения пропускаются. */
export function frontmatter(props) {
  const rows = Object.entries(props).filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length));
  return `---\n${rows.map(([k, v]) => `${k}: ${yamlValue(v)}`).join("\n")}\n---\n`;
}

const cell = (v) => String(v ?? "").replace(/\r?\n/g, " ").replace(/(?<!\\)\|/g, "\\|");

/** Таблица Markdown. Строки — массивы ячеек. Ссылки в ячейках делаются через cellLink. */
export function table(headers, rows) {
  if (!rows.length) return "_пусто_";
  // Ячейку со ссылкой не трогаем: в ней черта уже экранирована.
  const c = (v) => (String(v ?? "").includes("[[") ? String(v) : cell(v));
  return [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(c).join(" | ")} |`)].join("\n");
}

/** Полоска-диаграмма текстом: видна в любой теме и не требует дополнений. */
export function bar(value, max, width = 18) {
  if (!Number.isFinite(value) || !max) return "";
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export const num = (x) => (Number.isFinite(x) ? String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") : "—");

/** Метка для свойства tags: без пробелов и знаков, которые Obsidian в метке не терпит. */
export const tag = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}/_-]+/gu, "-").replace(/^-+|-+$/g, "");

/** Выноска Obsidian. */
export const callout = (kind, title, body) => `> [!${kind}] ${title}\n${String(body).split("\n").map((l) => `> ${l}`).join("\n")}`;

/** Ссылки-вики из текста заметки: пути без подписи и якоря. */
export function linksIn(text) {
  const out = [];
  for (const m of String(text).matchAll(/\[\[([^\]|#\\]+)(?:#[^\]|\\]*)?(?:\\?\|[^\]]*)?\]\]/g)) out.push(m[1].trim());
  return out;
}

/** Висячие ссылки: те, что не ведут ни на одну заметку набора. */
export function danglingLinks(files) {
  const names = new Set([...files.keys()].map((p) => p.replace(/\.(md|canvas|base)$/, "")));
  const full = new Set(files.keys());
  const bad = [];
  for (const [file, text] of files) {
    if (!file.endsWith(".md")) continue;
    for (const target of linksIn(text)) if (!names.has(target) && !full.has(target)) bad.push({ file, target });
  }
  return bad;
}

/**
 * Сборщик канвы (формат JSON Canvas 1.0). Узлы ставятся столбцами; связи тянутся
 * слева направо. Цвета: "1" красный, "2" оранжевый, "3" жёлтый, "4" зелёный,
 * "5" бирюзовый, "6" фиолетовый.
 */
export function canvas() {
  const nodes = [];
  const edges = [];
  let n = 0;
  const id = (p) => `${p}${(++n).toString(36)}`;
  return {
    file(file, x, y, { width = 320, height = 150, color } = {}) {
      const node = { id: id("f"), type: "file", file, x, y, width, height, ...(color ? { color } : {}) };
      nodes.push(node);
      return node.id;
    },
    text(text, x, y, { width = 320, height = 120, color } = {}) {
      const node = { id: id("t"), type: "text", text, x, y, width, height, ...(color ? { color } : {}) };
      nodes.push(node);
      return node.id;
    },
    group(label, x, y, width, height, color) {
      const node = { id: id("g"), type: "group", label, x, y, width, height, ...(color ? { color } : {}) };
      nodes.unshift(node); // группы лежат под узлами
      return node.id;
    },
    edge(fromNode, toNode, { label, fromSide = "right", toSide = "left", color } = {}) {
      edges.push({ id: id("e"), fromNode, fromSide, toNode, toSide, ...(label ? { label } : {}), ...(color ? { color } : {}) });
    },
    json() {
      return JSON.stringify({ nodes, edges }, null, "\t");
    },
  };
}

/** Столбец узлов равной высоты: возвращает координаты y для каждого. */
export function column(count, top, height, gap = 30) {
  return Array.from({ length: count }, (_, i) => top + i * (height + gap));
}
