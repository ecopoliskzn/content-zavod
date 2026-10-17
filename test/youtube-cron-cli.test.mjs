import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
test('CLI статистики, комментариев и отчёта работают через current-симлинк', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'yt-cron-'));
  const current = path.join(temp, 'current');
  symlinkSync(root, current, process.platform === 'win32' ? 'junction' : 'dir');
  for (const [file, args, expected] of [
    ['src/metrics/pull.mjs', ['--dry', '--channel=none'], /измерено 0/],
    ['src/comments/collect.mjs', ['--dry', '--only=youtube'], /разрешён только на российском сервере/],
    ['src/metrics/weekly.mjs', [], /# Неделя/],
  ]) {
    const result = spawnSync(process.execPath, [path.join(current, file), ...args], { encoding: 'utf8', timeout: 20000,
      env: { ...process.env, DATA_DIR: path.join(temp, 'data'), ZAVOD_ENV_FILE: path.join(temp, 'absent.env') } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, expected, file);
  }
  const saved = spawnSync(process.execPath, [path.join(current, 'src/metrics/weekly.mjs'), '--save', '--week=2026-10-05'], { encoding: 'utf8', timeout: 20000,
    env: { ...process.env, DATA_DIR: path.join(temp, 'data'), ZAVOD_ENV_FILE: path.join(temp, 'absent.env') } });
  assert.equal(saved.status, 0, saved.stderr);
  assert.match(saved.stdout, /сохранён без отправки/);
  assert.ok(existsSync(path.join(temp, 'data', 'reports', 'weekly', '2026-10-05.json')));
});
