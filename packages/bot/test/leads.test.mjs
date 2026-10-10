import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLeadStore } from "../src/leads.mjs";

function readLines(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => JSON.parse(s));
}

function newDir() {
  return mkdtempSync(join(tmpdir(), "liga-bot-leads-"));
}

test("saveLead дописывает лид в jsonl раньше любой попытки CRM", async () => {
  const dir = newDir();
  const store = createLeadStore({ storageDir: dir });
  const record = await store.saveLead({ name: "Пётр", phone: "+79990000001", source: "alyona:telegram" });

  assert.ok(record.id);
  assert.ok(record.createdAt);
  const строки = readLines(store.files.leadsFile);
  assert.equal(строки.length, 1);
  assert.equal(строки[0].name, "Пётр");

  rmSync(dir, { recursive: true, force: true });
});

test("submitLead без CRM только сохраняет лид и помечает crm как не настроенный", async () => {
  const dir = newDir();
  const store = createLeadStore({ storageDir: dir });
  const { lead, crm } = await store.submitLead({ name: "Ольга" });

  assert.ok(lead.id);
  assert.equal(crm.ok, false);
  assert.match(crm.error, /crm not configured/);
  assert.equal(readLines(store.files.leadsFile).length, 1);
  assert.equal(readLines(store.files.crmFile).length, 1);

  rmSync(dir, { recursive: true, force: true });
});

test("submitLead записывает лид в jsonl, даже если CRM падает (заявка не теряется)", async () => {
  const dir = newDir();
  const crm = { pushLead: async () => { throw new Error("сеть недоступна"); } };
  const store = createLeadStore({ storageDir: dir, crm, sourceTagPrefix: "alyona" });

  const { lead, crm: crmResult } = await store.submitLead({ name: "Иван", source: store.sourceTag("telegram") });

  assert.equal(lead.source, "alyona:telegram");
  assert.equal(crmResult.ok, false);
  assert.match(crmResult.error, /сеть недоступна/);
  assert.equal(readLines(store.files.leadsFile).length, 1, "лид обязан остаться в буфере при сбое CRM");
  assert.equal(readLines(store.files.crmFile)[0].ok, false);

  rmSync(dir, { recursive: true, force: true });
});

test("submitLead с успешной CRM пишет crmId в результат", async () => {
  const dir = newDir();
  const вызовы = [];
  const crm = {
    pushLead: async (lead, sourceLabel) => {
      вызовы.push({ lead, sourceLabel });
      return { ok: true, id: 777 };
    },
  };
  const store = createLeadStore({ storageDir: dir, crm });

  const { crm: crmResult } = await store.submitLead({ name: "Мария", sourceLabel: "alyona:instagram" });

  assert.equal(crmResult.ok, true);
  assert.equal(crmResult.crmId, 777);
  assert.equal(вызовы.length, 1);
  assert.equal(вызовы[0].sourceLabel, "alyona:instagram");

  rmSync(dir, { recursive: true, force: true });
});

test("retryFailed повторяет только лиды без успешной попытки в CRM", async () => {
  const dir = newDir();
  let попытка = 0;
  const crm = {
    pushLead: async (lead) => {
      попытка += 1;
      // Первый лид всегда падает, второй — с первой попытки успешен.
      if (lead.name === "Падающий") return { ok: false, error: "временный сбой" };
      return { ok: true, id: 1 };
    },
  };
  const store = createLeadStore({ storageDir: dir, crm });

  await store.submitLead({ name: "Падающий" });
  await store.submitLead({ name: "Успешный" });
  assert.equal(попытка, 2);

  const retried = await store.retryFailed();
  assert.equal(retried.length, 1, "должен повториться только упавший лид");
  assert.equal(попытка, 3);

  rmSync(dir, { recursive: true, force: true });
});

test("retryFailed после успешного повтора больше не трогает этот лид", async () => {
  const dir = newDir();
  let попыткаОк = false;
  const crm = {
    pushLead: async () => {
      const исход = popResult();
      return исход;
    },
  };
  let результаты = [{ ok: false, error: "сбой №1" }, { ok: true, id: 42 }];
  function popResult() {
    return результаты.shift() || { ok: true, id: 1 };
  }
  const store = createLeadStore({ storageDir: dir, crm });

  await store.submitLead({ name: "Клиент" }); // первая попытка падает
  const первый = await store.retryFailed(); // вторая попытка успешна
  assert.equal(первый.length, 1);
  assert.equal(первый[0].ok, true);

  const второй = await store.retryFailed(); // больше повторять нечего
  assert.equal(второй.length, 0);
  void попыткаОк;

  rmSync(dir, { recursive: true, force: true });
});

test("хранилище пишет только в свой storageDir", async () => {
  const dirA = newDir();
  const dirB = newDir();
  const storeA = createLeadStore({ storageDir: dirA });
  await storeA.saveLead({ name: "А" });

  assert.equal(readLines(storeA.files.leadsFile).length, 1);
  assert.ok(storeA.files.leadsFile.startsWith(dirA));
  assert.ok(!storeA.files.leadsFile.startsWith(dirB));

  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});
