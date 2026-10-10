// Store-and-forward для заявок (Фаза 3, D-013): сначала лид дописывается в jsonl-буфер
// на VPS в РФ (152-ФЗ — первичная фиксация до любой передачи наружу), потом идёт в CRM.
// Порт идеи lib/telegram/lead.ts (submitLead) из исходного проекта: сбой CRM не должен
// ронять заявку — она уже в файле, попытку можно повторить (retryFailed).

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

async function ensureDir(file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
}

async function appendJson(file, rec) {
  await ensureDir(file);
  await fs.appendFile(file, JSON.stringify(rec) + "\n", "utf8");
}

async function readJsonl(file) {
  let raw = "";
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // битая строка не должна ронять чтение всего буфера
    }
  }
  return out;
}

/**
 * @param {object} конфиг
 * @param {string} конфиг.storageDir каталог хранилища (152-ФЗ, свой каталог на VPS в РФ)
 * @param {{ pushLead: (lead: object, sourceLabel?: string) => Promise<{ok: boolean, id?: any, error?: string}> }} [конфиг.crm]
 *   клиент CRM (например createAmoClient) — необязателен: без него лид только сохраняется в jsonl
 * @param {string} [конфиг.sourceTagPrefix] префикс метки источника, например "demo"
 *   (используется как "<sourceTagPrefix>:<площадка>", как sourceTag в createBotInstance)
 */
export function createLeadStore({ storageDir, crm, sourceTagPrefix } = {}) {
  if (!storageDir) throw new TypeError("createLeadStore: нужен storageDir");

  const leadsFile = path.join(storageDir, "leads.jsonl");
  const crmFile = path.join(storageDir, "leads-crm.jsonl");

  function sourceTag(площадка) {
    return sourceTagPrefix ? `${sourceTagPrefix}:${площадка}` : площадка;
  }

  /** Дописывает лид в буфер. Не трогает CRM. Возвращает запись с id/createdAt. */
  async function saveLead(lead = {}) {
    const record = {
      id: lead.id || randomUUID(),
      createdAt: lead.createdAt || new Date().toISOString(),
      ...lead,
    };
    await appendJson(leadsFile, record);
    return record;
  }

  /** Пробует отправить уже сохранённый лид в CRM, результат/ошибку дописывает в свой jsonl. */
  async function pushToCrm(record) {
    if (!crm) {
      const result = { id: record.id, at: new Date().toISOString(), ok: false, error: "crm not configured" };
      await appendJson(crmFile, result);
      return result;
    }
    let outcome;
    try {
      outcome = await crm.pushLead(record, record.sourceLabel || record.source);
    } catch (e) {
      outcome = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const result = {
      id: record.id,
      at: new Date().toISOString(),
      ok: Boolean(outcome?.ok),
      crmId: outcome?.id,
      error: outcome?.ok ? undefined : outcome?.error || "unknown error",
    };
    await appendJson(crmFile, result);
    return result;
  }

  /** Сохраняет лид, затем пробует отправить в CRM. Сбой CRM не бросает исключение наружу. */
  async function submitLead(lead) {
    const record = await saveLead(lead);
    const crmResult = await pushToCrm(record);
    return { lead: record, crm: crmResult };
  }

  /**
   * Повторная отправка лидов, у которых последняя попытка в CRM не удалась (или её не было).
   * Читает оба буфера целиком — рассчитан на периодический ручной/крон-запуск, не на горячий путь.
   */
  async function retryFailed() {
    const [leads, results] = await Promise.all([readJsonl(leadsFile), readJsonl(crmFile)]);
    const lastResultById = new Map();
    for (const r of results) if (r?.id) lastResultById.set(String(r.id), r);

    const pending = leads.filter((l) => l?.id && !lastResultById.get(String(l.id))?.ok);
    const retried = [];
    for (const lead of pending) {
      retried.push(await pushToCrm(lead));
    }
    return retried;
  }

  return {
    saveLead,
    pushToCrm,
    submitLead,
    retryFailed,
    sourceTag,
    files: { leadsFile, crmFile },
  };
}
