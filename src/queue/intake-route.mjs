// Способ доставки берётся из подтверждённого target задания, а не из ответа модели.
import {targetEntryName,targetKey} from '../bot/media-intake-targets.mjs';
export function intakeRoute(entry,state){
 if(!/^mi-[a-f0-9]{16}-[1-9]\d*(?:-[a-f0-9]{6})?$/.test(entry.name||''))return null;
 const m=state.materials?.[String(entry.material||'').slice(7)];if(!m||entry.material!=='intake:'+m.id||m.mode!=='submitted')return null;
 for(const j of Object.values(state.jobs||{}))if(j.materialId===m.id&&j.status==='completed'&&j.artifactsVerified)for(const t of j.targets||[]){
  if(t.channel!==entry.channel||targetEntryName(j,t)!==entry.name||(m.targetJobs?m.targetJobs[targetKey(t)]!==j.id:m.revision!==j.revision))continue;
  return t.delivery_mode==='manual'?'manual':t.delivery_mode==='auto'?'auto':null;
 }
 return null;
}
