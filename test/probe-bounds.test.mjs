import test from 'node:test';import assert from 'node:assert/strict';import {probeVideo} from '../src/media/probe.mjs';
test('проверка загруженного видео не открывает сеть и имеет предел времени/вывода',()=>{
 let seen=false;assert.equal(probeVideo('private-fixture.mp4',{execute:(command,args,options)=>{seen=true;assert.equal(command,'ffprobe');assert.equal(args[args.indexOf('-protocol_whitelist')+1],'file,pipe');assert.equal(options.timeout,10000);assert.equal(options.maxBuffer,65536);return{error:Error('timeout')};}}),null);assert.equal(seen,true);
});
