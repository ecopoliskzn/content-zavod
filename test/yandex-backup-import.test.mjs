import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import path from 'node:path';
const script=path.resolve('ops/windows/import-yandex-backup-keys.ps1');
test('Yandex backup importer is valid Windows PowerShell syntax',{skip:process.platform!=='win32'},()=>{
 const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$parseTokens=$null;$parseErrors=$null;[System.Management.Automation.Language.Parser]::ParseFile('${script}',[ref]$parseTokens,[ref]$parseErrors)|Out-Null;if($parseErrors.Count){exit 1}`],{encoding:'utf8',timeout:15000});
 assert.equal(r.status,0,r.stderr);
});
test('unsafe bucket fails before secret prompt or network',{skip:process.platform!=='win32'},()=>{
 for(const bucket of ['invalid;command','UPPERCASE','a/b']){
  const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Bucket',bucket],{encoding:'utf8',timeout:15000});
  assert.notEqual(r.status,0);assert.match(r.stderr,/ValidatePattern|Validation|провер|шаблон/i);assert.doesNotMatch(r.stdout,/Paste|imported/);
 }
});
