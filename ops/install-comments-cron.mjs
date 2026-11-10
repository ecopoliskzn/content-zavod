// Узкая установка Threads-сбора: чужие строки crontab сохраняются байт-в-байт.
// Опрос кодовый; Threads API не чаще разрешённого интервала, недоставленные сводки отдельно.
import {execFileSync} from 'node:child_process';import {mkdirSync,writeFileSync} from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
const {dataPath,wrongUser}=await import(pathToFileURL(path.join(process.cwd(),'src','lib','env.mjs')));
if(wrongUser())throw Error('Запустите под пользователем zavod');
const marker='# ecopolis-comments-threads-v1',line='*/5 * * * * flock -n /tmp/zavod-comments.lock /usr/bin/node /opt/ecopolis-zavod/current/src/comments/collect.mjs --only=threads --send >> /var/log/zavod/comments.log 2>&1 '+marker;
let original='';try{original=execFileSync('crontab',['-l'],{encoding:'utf8'});}catch(e){if(e.status!==1)throw Error('Не удалось прочитать crontab');}
const kept=original.split('\n').filter(l=>!l.includes(marker)).join('\n').replace(/\n*$/,'\n'),next=kept+line+'\n';
if(process.argv.includes('--apply')){const folder=dataPath('cron-backups');mkdirSync(folder,{recursive:true,mode:0o700});writeFileSync(path.join(folder,'comments-'+new Date().toISOString().replace(/[:.]/g,'-')+'.txt'),original,{mode:0o600});execFileSync('crontab',['-'],{input:next});const installed=execFileSync('crontab',['-l'],{encoding:'utf8'});if(!installed.includes(line))throw Error('Cron не подтвердил установку');}
console.log(JSON.stringify({applied:process.argv.includes('--apply'),managedJobs:1,intervalMinutes:5,threadsReadThrottleHours:20,foreignLinesPreserved:true}));
