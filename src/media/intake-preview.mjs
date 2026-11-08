// Закрытый просмотр ровно выбранного исходника редакторского задания через SSH.
// Файл не получает публичного URL; после скачивания сверяются байты, SHA и актуальность job.
import {mkdirSync,statSync,readFileSync,writeFileSync,renameSync,unlinkSync,existsSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {dataPath,env} from '../lib/env.mjs';
const extensions={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','video/mp4':'.mp4','video/quicktime':'.mov'};
export async function intakePreview(claimFile,mediaId,{refresh,folder=dataPath('intake-editor','previews'),server=env('MEDIA_SSH_TARGET')||'zavod@104.171.136.64',transfer}={}){
 const current=await refresh(claimFile),job=current.job,asset=job?.input?.files?.find(f=>f.mediaId===mediaId);
 if(!/^[a-f0-9]{16}$/.test(job?.id||'')||!asset||!/^med_[a-f0-9]{32}$/.test(mediaId)||!/^[a-f0-9]{64}$/.test(asset.sha256||'')||!extensions[asset.mime]||!Number.isSafeInteger(asset.bytes)||asset.bytes<=0||asset.bytes>512*1024*1024)throw Error('invalid preview asset');
 if(job.protocolVersion===2&&(!job.input.targetMedia||!Object.values(job.input.targetMedia).some(ids=>Array.isArray(ids)&&ids.includes(mediaId))))throw Error('asset not selected for this task');
 if(server!=='zavod@104.171.136.64')throw Error('preview server requires explicit configured implementation');
 const dir=path.join(folder,job.id);mkdirSync(dir,{recursive:true,mode:0o700});
 const temp=path.join(dir,'.download-'+randomUUID()),file=path.join(dir,asset.sha256+extensions[asset.mime]);
 try{
  writeFileSync(temp,'',{mode:0o600,flag:'wx'});
  if(transfer)await transfer(asset,temp);
  else{const profile=process.env.USERPROFILE;if(!profile)throw Error('operator profile required');execFileSync('scp',['-q','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes','-o','ConnectTimeout=15','-o','UserKnownHostsFile='+path.join(profile,'.ssh','known_hosts'),'-i',path.join(profile,'.ssh','ecopolis_operator_ed25519'),`${server}:/opt/ecopolis-data/media-library/blobs/${asset.sha256}`,temp],{stdio:'ignore',windowsHide:true,timeout:60000});}
  if(statSync(temp).size!==asset.bytes||createHash('sha256').update(readFileSync(temp)).digest('hex')!==asset.sha256)throw Error('preview hash mismatch');
  const fresh=await refresh(claimFile),after=fresh.job?.input?.files?.find(f=>f.mediaId===mediaId);
  if(fresh.job.id!==job.id||fresh.job.revision!==job.revision||fresh.job.inputHash!==job.inputHash||after?.sha256!==asset.sha256)throw Error('preview task changed');
  renameSync(temp,file);return{file,jobId:job.id,revision:job.revision,inputHash:job.inputHash,mediaId,sha256:asset.sha256,bytes:asset.bytes,mime:asset.mime,visibility:'private-local'};
 }finally{if(existsSync(temp))unlinkSync(temp);}
}
