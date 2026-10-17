// Cron запускает команды через current — симлинк версии. Node раскрывает import URL,
// но argv оставляет с симлинком: сравниваем реальные пути, иначе команда молча не работает.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export function isMain(url) {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(url)) === realpathSync(process.argv[1]); }
  catch { return false; }
}
