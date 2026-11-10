import test from 'node:test';import assert from 'node:assert/strict';
import {planMetaHistoryCron,META_HISTORY_CRON} from '../ops/install-meta-history-cron.mjs';
test('узкая установка сохраняет весь действующий crontab и повтор не добавляет строк',()=>{
 const before='# backup and release\n1 * * * * /usr/bin/backup\n# meta-history is documented here\n';
 const next=planMetaHistoryCron(before,'Etc/UTC');assert.equal(next,before+META_HISTORY_CRON+'\n');assert.equal(planMetaHistoryCron(next,'UTC'),next);
});
test('иной сборщик, дубль и несовместимый часовой пояс удерживают установку',()=>{
 for(const text of [META_HISTORY_CRON+'\n'+META_HISTORY_CRON+'\n','0 2 * * * node /app/src/metrics/meta-baseline.mjs\n','CRON_TZ=Europe/Moscow\n'])assert.throws(()=>planMetaHistoryCron(text,'UTC'));
 assert.throws(()=>planMetaHistoryCron('','Europe/Moscow'));
});
