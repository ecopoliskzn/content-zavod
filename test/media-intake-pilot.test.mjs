import test from 'node:test';import assert from 'node:assert/strict';
import {evaluatePilot} from '../src/bot/media-intake-pilot.mjs';
const now=Date.parse('2026-11-08T12:00:00Z'),expected={version:'abc1234 20261108-100000',groupId:'-1001',topicId:309,handoffMode:'A',roles:['S1','S2']};
const receipt=()=>({schema:1,checkedBy:'S0',artifact_ref:'pilot:synthetic',checked_at:'2026-11-08T11:00:00Z',expires_at:'2026-11-09T10:00:00Z',...expected,checks:{duplicateIgnored:true,outsiderRejected:true,wrongScopeRejected:true,originalsPrivate:true,publicationNotApproved:true,filesVerified:true,cardDelivered:true},editorPaths:{S1:{mode:'A',verified:true,artifact_ref:'claim:s1'},S2:{mode:'A',verified:true,artifact_ref:'claim:s2'}}});
test('P0 принимает только свежий акт точной версии/области/режима с отрицательными пробами',()=>{
 assert.equal(evaluatePilot(receipt(),expected,now).result,'passed');assert.equal(evaluatePilot(null,expected,now).result,'unknown');
 for(const patch of [{version:'old'},{topicId:310},{groupId:'-1002'},{handoffMode:'B'},{checked_at:'2026-11-06T11:00:00Z'},{expires_at:'2026-11-08T10:00:00Z'},{checked_at:'2026-11-08T13:00:00Z'},{checks:{enabled:true}},{editorPaths:{S1:{mode:'A',verified:true,artifact_ref:'one'}}}])assert.notEqual(evaluatePilot({...receipt(),...patch},expected,now).result,'passed');
 assert.equal(evaluatePilot(receipt(),{...expected,version:null},now).result,'unknown');
});
