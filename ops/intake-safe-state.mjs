// Только счётчики перед установкой: ни авторы, ни задания, ни переписка не выводятся.
import path from 'node:path';import {pathToFileURL} from 'node:url';
const runtime=await import(pathToFileURL(path.join(process.cwd(),'src','bot','media-intake-runtime.mjs'))),state=runtime.instance().store.read();
const count={legacy:{},v2:{}};for(const job of Object.values(state.jobs)){const kind=job.protocolVersion===2?'v2':'legacy',status=['queued','claimed','completed','superseded'].includes(job.status)?job.status:'other';count[kind][status]=(count[kind][status]||0)+1;}
const active=Object.values(state.materials).filter(m=>!m.workflowClosed&&!['archive','cancelled','closed'].includes(m.mode));
console.log(JSON.stringify({checkedAt:new Date().toISOString(),enabled:runtime.isEnabled(),materials:Object.keys(state.materials).length,activeMaterials:active.length,jobs:count,personalDataRead:false,queueChanged:false}));
