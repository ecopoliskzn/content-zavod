// Запись ключа в файл окружения: атомарно и молча.
//
// Продлённый маркер нужно положить обратно в файл, не задев соседние строки и ни разу
// не показав значение. Пишем во временный файл и переименовываем: читатель никогда не
// увидит половину файла.
//
// ГРАБЛЯ. Если файл окружения проброшен в контейнер одиночным bind-mount, rename
// подменяет его только внутри контейнера, и на хосте новый маркер теряется при
// перезапуске. Поэтому продление запускается на хосте (cron), а не внутри контейнера.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { envTarget, wrongUser, _reset } from "./env.mjs";

/**
 * @param {Record<string, string>} values имя → значение
 * @param {string} [file] по умолчанию файл окружения этой машины: названный явно либо прочитанный
 */
export function setEnv(values, file = envTarget()) {
  // Файл окружения, переписанный под root, завод потом не прочитает: бот молчит до утра.
  const foreign = wrongUser();
  if (foreign) throw Object.assign(new Error(foreign), { code: "ENV" });
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  const left = new Map(Object.entries(values));
  const next = lines.map((line) => {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
    if (m && left.has(m[1])) {
      const v = left.get(m[1]);
      left.delete(m[1]);
      return `${m[1]}=${v}`;
    }
    return line;
  });
  while (next.length && next[next.length - 1] === "") next.pop();
  for (const [k, v] of left) next.push(`${k}=${v}`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, next.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
  _reset();
  return file;
}
