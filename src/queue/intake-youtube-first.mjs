// Премьера служебного видеокомплекта связана с точным заданием и ревизией.
// Имя отличается между форматами; чужой ролик и старый хеш не заменяют квитанцию.
import {targetEntryName,targetKey} from '../bot/media-intake-targets.mjs';
export function intakeYoutubeWaiting(entry,{jobs,getEntry,material}){
 const managed=/^mi-([a-f0-9]{16})-([1-9]\d*)(?:-[a-f0-9]{6})?$/.exec(String(entry.name||''));
 if(!managed||entry.material!==`intake:${managed[1]}`)return null;
 if(entry.channel==='youtube'||!(['video','short','reel'].includes(entry.kind)||entry.media?.some(m=>m.type==='video')))return false;
 try{
  const candidates=jobs.filter(j=>j.materialId===managed[1]&&j.revision===Number(managed[2])&&j.status==='completed'&&j.artifactsVerified&&j.targets.some(t=>t.channel===entry.channel&&targetEntryName(j,t)===entry.name));
  if(candidates.length!==1)return true;
  const job=candidates[0],youtube=(material?.targets||job.targets).filter(t=>t.channel==='youtube');
  return youtube.some(t=>{
   const owner=material?.targetJobs?jobs.find(j=>j.id===material.targetJobs[targetKey(t)]&&j.materialId===job.materialId&&j.targets.some(x=>targetKey(x)===targetKey(t))):job;
   if(!owner||owner.status!=='completed'||!owner.artifactsVerified)return true;
   const ref=owner.queueResults?.[targetKey(t)]||(owner.targets.filter(x=>x.channel===t.channel).length===1?owner.queueResults?.[t.channel]:null);
   const first=ref?.id?getEntry(ref.id):null;
   return !first||first.channel!=='youtube'||first.material!==entry.material||first.name!==targetEntryName(owner,t)||first.contentHash!==ref.contentHash||first.status!=='published'||!first.result?.id||!/^https:\/\//.test(first.result?.link||'');
  });
 }catch{return true;}
}
