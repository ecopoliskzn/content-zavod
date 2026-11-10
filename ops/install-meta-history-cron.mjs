// Добавляет только ежедневный числовой сбор Meta к действующему crontab.
// Чужие строки сохраняются, иной сборщик/дубль/не-UTC удерживают установку.
import {execFileSync} from 'node:child_process';import {mkdirSync,writeFileSync,openSync,closeSync} from 'node:fs';import path from 'node:path';
import {isMain} from '../src/lib/is-main.mjs';
export const META_HISTORY_CRON='20 4 * * * /usr/bin/flock -n /tmp/zavod-meta-history.lock /usr/bin/node /opt/ecopolis-zavod/current/src/metrics/meta-history.mjs >> /var/log/zavod/meta-history.log 2>&1';
const utc=value=>['UTC','Etc/UTC','Etc/GMT','GMT'].includes(value);
export function planMetaHistoryCron(original,timezone){
 if(!utc(timezone))throw Error('Нужен подтверждённый UTC сервера');
 const active=original.split(/\r?\n/).map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));
 if(active.some(l=>l.startsWith('CRON_TZ=')&&!utc(l.slice(8).replaceAll('"','').replaceAll("'",''))))throw Error('CRON_TZ меняет время задачи');
 const metrics=active.filter(l=>/meta-history|meta-baseline|\/metrics\//.test(l));
 if(metrics.length){if(metrics.length===1&&metrics[0]===META_HISTORY_CRON)return original;throw Error('Уже существует другой сборщик Meta; установка удержана');}
 return original+(original&&!original.endsWith('\n')?'\n':'')+META_HISTORY_CRON+'\n';
}
async function main(){
 const {wrongUser,dataPath}=await import('../src/lib/env.mjs');if(wrongUser())throw Error('Запустите под пользователем завода');
 const timezone=execFileSync('timedatectl',['show','--property=Timezone','--value'],{encoding:'utf8'}).trim();
 let original='';try{original=execFileSync('crontab',['-l'],{encoding:'utf8'});}catch(e){if(e.status!==1)throw Error('Не удалось прочитать crontab');}
 const next=planMetaHistoryCron(original,timezone),apply=process.argv.includes('--apply');
 if(apply){
  const log='/var/log/zavod/meta-history.log';const fd=openSync(log,'a',0o600);closeSync(fd);
  if(next!==original){const folder=dataPath('cron-backups');mkdirSync(folder,{recursive:true,mode:0o700});writeFileSync(path.join(folder,'meta-history-'+new Date().toISOString().replace(/[:.]/g,'-')+'.txt'),original,{mode:0o600});
   // Не затираем даже чужую правку, появившуюся между планом и установкой.
   let latest='';try{latest=execFileSync('crontab',['-l'],{encoding:'utf8'});}catch(e){if(e.status!==1)throw e;}if(latest!==original)throw Error('Crontab изменился; повторите сверку');
   execFileSync('crontab',['-'],{input:next});
  }
  if(execFileSync('crontab',['-l'],{encoding:'utf8'})!==next)throw Error('Установка cron не подтверждена');
 }
 console.log(JSON.stringify({applied:apply,changed:next!==original,timezone,managedJobs:1,mskTime:'07:20',foreignLinesPreserved:true,line:META_HISTORY_CRON}));
}
if(isMain(import.meta.url))main().catch(()=>{console.error('Установка ежедневного сбора Meta удержана: проверьте UTC, существующий сборщик и права.');process.exitCode=2;});
