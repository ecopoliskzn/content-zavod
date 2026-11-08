// Готовность пилота подтверждает свежий акт S0 из закрытого runtime-хранилища.
// Включённый приём и успешные unit-тесты не заменяют транспортные квитанции.
const CHECKS=['duplicateIgnored','outsiderRejected','wrongScopeRejected','originalsPrivate','publicationNotApproved','filesVerified','cardDelivered'];
export function evaluatePilot(receipt,expected,now=Date.now()){
 const fail=(reason,result='blocked')=>({result,reason,evidence:[]});
 if(!receipt||!expected?.version)return fail('pilot_evidence_missing','unknown');
 if(receipt.schema!==1||receipt.checkedBy!=='S0'||typeof receipt.artifact_ref!=='string'||!receipt.artifact_ref)return fail('pilot_receipt_invalid');
 if(['version','groupId','topicId','handoffMode'].some(k=>receipt[k]!==expected[k]))return fail('pilot_scope_or_version_mismatch');
 const at=Date.parse(receipt.checked_at),until=Date.parse(receipt.expires_at);
 if(!Number.isFinite(at)||!Number.isFinite(until)||at>now||until<=now||until<at||now-at>86400000||until-at>86400000)return fail('pilot_evidence_stale');
 if(CHECKS.some(k=>receipt.checks?.[k]!==true))return fail('pilot_probes_incomplete');
 if(!Array.isArray(expected.roles)||!expected.roles.length||expected.roles.some(role=>!['S1','S2'].includes(role)||receipt.editorPaths?.[role]?.mode!==expected.handoffMode||receipt.editorPaths[role].verified!==true||!receipt.editorPaths[role].artifact_ref))return fail('pilot_editor_path_unverified');
 return{result:'passed',reason:'trusted-deployment-pilot-receipt',evidence:[{type:'deployment-pilot',result:'passed',checked_at:receipt.checked_at,expires_at:receipt.expires_at,checked_by:'S0',input_revision:expected.version,artifact_ref:receipt.artifact_ref}]};
}
