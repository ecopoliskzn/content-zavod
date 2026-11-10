import test from 'node:test';import assert from 'node:assert/strict';import {intakeRoute} from '../src/queue/intake-route.mjs';
const id='a'.repeat(16),entry={material:'intake:'+id,name:`mi-${id}-1`,channel:'instagram'},target={channel:'instagram',format:'carousel',delivery_mode:'manual'},job={id:'job',materialId:id,revision:1,status:'completed',artifactsVerified:true,targets:[target]},state={materials:{[id]:{id,mode:'submitted',revision:1,targetJobs:{'instagram:carousel':'job'}}},jobs:{job}};
test('manual выбирается только подтверждённым current target, extra модели не управляет маршрутом',()=>{
 assert.equal(intakeRoute(entry,state),'manual');assert.equal(intakeRoute({...entry,extra:{delivery_mode:'auto'}},state),'manual');
 assert.equal(intakeRoute(entry,{...state,materials:{[id]:{...state.materials[id],targetJobs:{'instagram:carousel':'new'}}}}),null);
 assert.equal(intakeRoute({...entry,name:'legacy',extra:{delivery_mode:'manual'}},state),null);
});
