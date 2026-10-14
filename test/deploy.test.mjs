// Архив выкладки должен содержать файлы, которые доктор требует на сервере.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

test("выкладка включает все промпты сессий из реестра", () => {
  const deploy = readFileSync(new URL("../ops/deploy.sh", import.meta.url), "utf8");
  const parts = deploy.match(/^PARTS=\(([^)]+)\)$/m)?.[1].split(/\s+/) || [];
  const config = JSON.parse(readFileSync(new URL("../zavod.config.json", import.meta.url), "utf8"));
  for (const session of config.sessions) {
    assert.ok(existsSync(new URL(`../${session.prompt}`, import.meta.url)));
    assert.ok(parts.some((p) => session.prompt === p || session.prompt.startsWith(`${p}/`)), `архив не содержит ${session.prompt}`);
  }
});
