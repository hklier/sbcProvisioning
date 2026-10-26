import {fingerprint} from './provisioning.js';
import {normalized} from './transaction.js';

// JSON property order and SDM collection order are not configuration changes.
function canonical(value) {
  if(Array.isArray(value))return value.map(canonical);
  if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])]));
  return value;
}
const sorted=rows=>(rows || []).map(canonical).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
export function previewState(plan) {
  return canonical({
    configurations:sorted((plan.configurations || []).map(c=>({deviceId:c.deviceId,operations:sorted(c.operations.map(op=>({method:op.method,path:op.path,body:op.body?normalized(op.body):undefined,before:normalized(op.before),requests:op.requests===undefined?undefined:sorted(op.requests.map(r=>({method:r.method,path:r.path,body:normalized(r.body)})))})))}))),
    routes:sorted(plan.routes),routeSnapshot:plan.routeSnapshot===undefined?undefined:sorted(plan.routeSnapshot),
    routeBaselineVerified:plan.routeBaselineVerified,associations:sorted(plan.associations),
    deviceIds:sorted(plan.deviceIds),groupIds:sorted(plan.groupIds),routeSetId:plan.routeSetId
  });
}
export const previewDigest=plan=>fingerprint(previewState(plan));
export function changedSections(before,after) {
  const a=previewState(before),b=previewState(after);
  return [...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>fingerprint(a[k]??null)!==fingerprint(b[k]??null));
}
