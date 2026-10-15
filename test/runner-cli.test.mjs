// Cron обращается к релизу через ссылку current: такой запуск тоже обязан писать пульс.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, symlinkSync, existsSync, readFileSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

test('runner через ссылку current выполняет проход и пишет пульс', () => {
  const dir=mkdtempSync(path.join(os.tmpdir(),'zavod-runner-cli-'));
  const current=path.join(dir,'current');
  const root=fileURLToPath(new URL('..',import.meta.url));
  try {
    symlinkSync(root,current,process.platform==='win32'?'junction':'dir');
    const data=path.join(dir,'data');
    const result=spawnSync(process.execPath,[path.join(current,'src','queue','runner.mjs')],{
      cwd:dir,encoding:'utf8',timeout:15000,
      env:{...process.env,ZAVOD_ENV_FILE:path.join(dir,'absent.env'),DATA_DIR:data,QUEUE_API_BASE:'',TG_GROUP_ID:'',TG_BOT_TOKEN:'',TG_RELAY_URL:'',TG_RELAY_SECRET:''},
    });
    assert.equal(result.status,0,result.stderr);
    const beat=path.join(data,'heartbeat.json');
    assert.ok(existsSync(beat),'процесс завершился успешно, но проход не запускался');
    assert.ok(Number.isFinite(Date.parse(JSON.parse(readFileSync(beat,'utf8')).runner)));
  } finally {
    rmSync(current,{recursive:true,force:true});
    rmSync(dir,{recursive:true,force:true});
  }
});
