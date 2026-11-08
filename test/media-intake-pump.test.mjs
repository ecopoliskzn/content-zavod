import test from 'node:test';import assert from 'node:assert/strict';import {createIntakePump} from '../src/bot/media-intake-pump.mjs';
test('кодовый проход продолжает quiet и восстановленное ожидание без нового update',async()=>{
 let now=0,saved=1,cards=0;const flush=async()=>{if(saved&&now>=5){cards++;saved=0;}return{ok:true};};
 const first=createIntakePump({flush,deliver:async()=>{}});await first.run();assert.equal(cards,0);
 // Перезапуск процесса: в устойчивом состоянии всё ещё сохранён комплект, события нет.
 now=6;const restarted=createIntakePump({flush,deliver:async()=>{}});await restarted.run();await restarted.run();assert.equal(cards,1);
});
test('singleflight, выключенный приём и ошибка не вызывают лишний проход/LLM',async()=>{
 let done,flushed=0,delivered=0;const wait=new Promise(r=>done=r);const pump=createIntakePump({flush:async()=>{flushed++;await wait;return{};},deliver:async()=>{delivered++;}});
 const a=pump.run(),b=pump.run();assert.equal(a,b);done();await a;assert.equal(flushed,1);assert.equal(delivered,1);
 const off=createIntakePump({enabled:()=>false,flush:()=>{throw Error('unexpected');}});assert.equal((await off.run()).disabled,true);
 const errors=[];const fail=createIntakePump({flush:async()=>{throw Error('secret-url');},deliver:async()=>{},onError:e=>errors.push(e)});await fail.run();assert.deepEqual(errors,['intake_pending']);
});
