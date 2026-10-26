import {selector,configRoot,writableConfig,configUpdateRequests,fingerprint,checkResult} from './provisioning.js';
const enc=encodeURIComponent;
export function normalized(e) {
  if(!e)return null;
  const clean={elementTypePath:e.elementTypePath,attributes:(e.attributes || []).filter(a=>!['lastModifiedBy','lastModifiedDate','dataVersion'].includes(a.name)).map(a=>({name:a.name,value:String(a.value)})).sort((a,b)=>a.name.localeCompare(b.name)),childrenElements:(e.childrenElements || []).map(normalized)};
  clean.childrenElements.sort((a,b)=>fingerprint(a).localeCompare(fingerprint(b)));if(e.parentElement)clean.parentElement=normalized(e.parentElement);return clean;
}
const same=(a,b)=>fingerprint(normalized(a))===fingerprint(normalized(b));
async function current(client,device,object) {
  const key=selector(object);const rows=await client.list(`${configRoot(device)}?elementTypePath=${object.elementTypePath}`,'configElements');
  if(!rows.some(r=>fingerprint(selector(r))===fingerprint(key)))return null;
  return client.request('POST',`${configRoot(device)}/retrieve`,key);
}
function routeBody(row){const out={...row};delete out.objectId;return out;}
function routeKey(row){return `${row.rangeStart}|${row.rangeEnd}`;}
function routeState(rows){return rows.map(r=>routeBody(r)).sort((a,b)=>fingerprint(a).localeCompare(fingerprint(b)));}
async function poll(client,path,predicate,sleep,timeoutMs) {
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) {const result=await client.request('GET',path);if(predicate(result))return result;await sleep(1000);}
  throw new Error(`Timed out waiting for SDM task ${path}`);
}
export async function executeTransaction(client,plan,{revalidate=async()=>{},sleep=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=180000}={}) {
  const report={status:'not-needed',steps:[],errors:[],devices:[],routeUpdates:[]};
  const completed=[],locks=[],attemptedConfigs=[],attemptedAssociations=[];
  const routes=plan.routes || (plan.route?[plan.route]:[]);
  let routesAttempted=false,pushAttempted=false,mutation=false;
  const updates=[];
  const record=(phase,label,fn)=>async()=>{try{const result=await fn();report.steps.push({phase,label,status:'success'});return result;}catch(e){report.steps.push({phase,label,status:'failed',error:e.message});throw e;}};
  async function pushRoutes(groups) {
    pushAttempted=true;
    const group=groups.map(deviceGroupId=>({deviceGroupId}));
    const result=await client.request('POST',`/routeSets/${enc(plan.routeSetId)}/devices/action`,{deviceGroups:{deviceGroup:group.length===1?group[0]:group},action:'Update',failureAction:'rollback'});
    if(!result?.objectId)throw new Error('Route push did not return a task ID; deployment outcome is uncertain');
    const task={id:result.objectId,committed:false};updates.push(task);
    await poll(client,`/routeSets/routeUpdates/${enc(task.id)}`,r=>{
      const rows=r.deviceStatusList || [];
      if([r.updateStatus,...rows.flatMap(d=>[d.status,d.pushStatus])].some(s=>/fail|error|cancel|rollback/i.test(s || '')))throw new Error(`LRT deployment failed (${task.id})`);
      const completedGroups=new Set(rows.filter(d=>d.status==='Completed' && d.pushStatus==='Completed').map(d=>d.deviceGroupId));
      return r.updateStatus==='Completed' && groups.every(g=>completedGroups.has(g));
    },sleep,timeoutMs);
    return task;
  }
  async function restoreConfigurations() {
    for(const config of [...attemptedConfigs].reverse()) {
      const device=config.deviceId;let failed=false;
      const step=async(label,fn)=>{try{await record('rollback',`${device}: ${label}`,fn)();}catch(e){failed=true;report.errors.push(`${device}: ${label}: ${e.message}`);}};
      await step('clear this session’s staged changes',()=>client.request('DELETE',`/configuration/deviceConfigs/${enc(device)}/configurationChanges`));
      await step('reload configuration',()=>client.request('GET',`/configuration/devices/${enc(device)}/loadConfig`));
      // Undo new dependents first, then restore existing/deleted objects in dependency order.
      for(const op of [...config.operations].reverse().filter(op=>!op.before))await step(`remove new ${op.body.elementTypePath}`,async()=>{if(await current(client,device,op.body))await client.request('POST',`${configRoot(device)}/delete`,selector(op.body));});
      const priority={realmConfig:0,sessionAgent:1,sessionAgentGroup:2,sipInterface:3,localPolicy:4};
      for(const op of config.operations.filter(op=>op.before).sort((a,b)=>priority[a.before.elementTypePath]-priority[b.before.elementTypePath]))await step(`restore ${op.before.elementTypePath}`,async()=>{
        const existing=await current(client,device,op.before);
        if(!existing)await client.request('POST',`${configRoot(device)}/add`,writableConfig(op.before));
        else if(!same(existing,op.before))for(const request of await configUpdateRequests(client,device,existing,op.before))await client.request(request.method,request.path,request.body);
      });
      await step('save/activate original configuration if changes remain',async()=>{
        const summary=await client.request('GET',`/configuration/devices/${enc(device)}`);
        if(summary?.pendingChanges===undefined || !Number.isFinite(Number(summary.pendingChanges)))throw new Error('Cannot verify pending recovery changes');
        if(Number(summary.pendingChanges)!==0)checkResult(await client.request('POST',`/configuration/devices/${enc(device)}/action`,{type:'SaveActivateConfig'}));
      });
      await step('verify restored objects',async()=>{
        await client.request('GET',`/configuration/devices/${enc(device)}/loadConfig`);
        for(const op of config.operations){const actual=await current(client,device,op.before || op.body);if(op.before?!same(actual,op.before):actual!==null)throw new Error(`${(op.before || op.body).elementTypePath} differs from original state`);}
      });
      report.devices.push({deviceId:device,status:failed?'incomplete':'restored'});
    }
  }
  async function restoreRoutes() {
    if(!routesAttempted)return;
    let restored=true;let nativeRestored=updates.length>0;
    for(const task of [...updates].reverse()) {
      try {
        const recovered=r=>{
          if(/fail|error/i.test(r.rollbackStatus || ''))throw new Error('SDM reported failed LRT rollback');
          const rows=r.deviceStatusList || [];
          return /completed|success/i.test(r.rollbackStatus || '') && plan.groupIds.every(g=>rows.some(d=>d.deviceGroupId===g && /completed|success/i.test(d.rollBackStatus || d.rollbackStatus || '')));
        };
        const previous=await client.request('GET',`/routeSets/routeUpdates/${enc(task.id)}`);
        const alreadyRecovered=/completed|success/i.test(previous.rollbackStatus || '') && recovered(previous);
        if(!alreadyRecovered){
          await record('rollback',`request rollback for LRT task ${task.id}`,()=>client.request('POST',`/routeSets/routeUpdates/${enc(task.id)}/action`,{type:'Rollback'}))();
          await poll(client,`/routeSets/routeUpdates/${enc(task.id)}`,recovered,sleep,timeoutMs);
        }else report.steps.push({phase:'rollback',label:`SDM already rolled back LRT task ${task.id}; verified all target groups`,status:'success'});
        report.routeUpdates.push({taskId:task.id,status:'rolled-back'});
      } catch(e) {nativeRestored=false;restored=false;report.errors.push(`LRT task ${task.id}: ${e.message}`);report.routeUpdates.push({taskId:task.id,status:'unverified'});}
    }
    try {
      await record('rollback','restore original SDM route entries',async()=>{
        let rows=await client.list(`/routeSets/${enc(plan.routeSetId)}/entries/`,'routeSetEntries');
        const originals=plan.routeSnapshot || routes.map(op=>op.before).filter(Boolean);
        const affected=new Set(routes.flatMap(op=>[op.before && routeKey(op.before),op.body && routeKey(op.body)].filter(Boolean)));
        const oldKeys=new Set(originals.map(routeKey));
        for(const row of rows.filter(r=>affected.has(routeKey(r)) && !oldKeys.has(routeKey(r))))await client.request('DELETE',`/routeSets/${enc(plan.routeSetId)}/entries/${enc(row.objectId)}`);
        rows=await client.list(`/routeSets/${enc(plan.routeSetId)}/entries/`,'routeSetEntries');
        for(const before of originals.filter(r=>affected.has(routeKey(r)))){
          const existing=rows.find(r=>routeKey(r)===routeKey(before));
          if(!existing)await client.request('POST',`/routeSets/${enc(plan.routeSetId)}/entries/`,routeBody(before));
          else if(fingerprint(routeBody(existing))!==fingerprint(routeBody(before)))await client.request('PUT',`/routeSets/${enc(plan.routeSetId)}/entries/${enc(existing.objectId)}`,routeBody(before));
        }
        const actual=await client.list(`/routeSets/${enc(plan.routeSetId)}/entries/`,'routeSetEntries');
        if(fingerprint(routeState(actual.filter(r=>affected.has(routeKey(r)))))!==fingerprint(routeState(originals.filter(r=>affected.has(routeKey(r))))))throw new Error('Route entries differ from original content');
      })();
      if(pushAttempted && !nativeRestored) {
        if(!plan.routeBaselineVerified)throw new Error('No verified common pre-update LRT content is available for every target. Native task rollback could not be verified; manual recovery is required.');
        const task=await record('rollback','redeploy restored routing table to all targets',()=>pushRoutes(plan.groupIds))();
        await client.request('POST',`/routeSets/routeUpdates/${enc(task.id)}/action`,{type:'Commit'});task.committed=true;
      }
    }catch(e){restored=false;report.errors.push(`Restore route table: ${e.message}`);}
    report.routes=restored?'restored':'incomplete';
  }
  try {
    const resources=[...plan.deviceIds.map(d=>`/inventory/deviceMgmt/devices/${enc(d)}/action`),...(routes.length?[`/routeSets/${enc(plan.routeSetId)}/action`]:[])].sort();
    for(const resource of resources){await client.request('POST',resource,{type:'Lock'});locks.push(resource);}
    await revalidate();
    for(const op of plan.associations || []){mutation=true;attemptedAssociations.push(op);await client.request(op.method,op.path,op.body);completed.push('Associated selected device groups');}
    for(const config of plan.configurations){const requests=config.operations.flatMap(op=>op.requests || [op]);if(!requests.length)continue;mutation=true;attemptedConfigs.push(config);for(const request of requests)await client.request(request.method,request.path,request.body);}
    // Stage both devices before activating either one.
    for(const config of attemptedConfigs){checkResult(await client.request('POST',`/configuration/devices/${enc(config.deviceId)}/action`,{type:'SaveActivateConfig'}));completed.push(`Configuration activated on ${config.deviceId}`);}
    for(const op of routes){mutation=true;routesAttempted=true;await client.request(op.method,op.path,op.body);}
    if(routes.length){completed.push('LRT entries stored in SDM');const task=await pushRoutes(plan.groupIds);await client.request('POST',`/routeSets/routeUpdates/${enc(task.id)}/action`,{type:'Commit'});task.committed=true;completed.push(`LRT deployed and committed (${task.id})`);}
    for(const resource of [...locks].reverse()){await client.request('POST',resource,{type:'Unlock'});locks.splice(locks.indexOf(resource),1);}
    return {completed,rollback:report};
  }catch(error){
    if(mutation){report.status='running';
      const resources=[...plan.deviceIds.map(d=>`/inventory/deviceMgmt/devices/${enc(d)}/action`),...(routes.length?[`/routeSets/${enc(plan.routeSetId)}/action`]:[])].sort();
      for(const resource of resources.filter(r=>!locks.includes(r)))try{await client.request('POST',resource,{type:'Lock'});locks.push(resource);}catch(e){report.errors.push(`Cannot reacquire ${resource}: ${e.message}`);}
      await restoreConfigurations();await restoreRoutes();
      for(const op of [...attemptedAssociations].reverse())for(const group of op.body.assocDevices){try{await record('rollback',`remove new association ${group.deviceGroupId}`,async()=>{
        const path=op.path.replace(/\/$/,'');const associated=async()=>{try{return await client.request('GET',path+'/');}catch(e){if(e.status===404)return {assocDevices:[]};throw e;}};const existing=await associated();
        if(existing.assocDevices?.some(g=>g.deviceGroupId===group.deviceGroupId))await client.request('DELETE',`${path}/${enc(group.deviceGroupId)}`);
        const after=await associated();if(after.assocDevices?.some(g=>g.deviceGroupId===group.deviceGroupId))throw new Error('Association still exists');
      })();}catch(e){report.errors.push(e.message);}}
      report.status=report.errors.length?'incomplete':'restored';
    }
    for(const deviceId of plan.deviceIds.filter(d=>!report.devices.some(r=>r.deviceId===d)))report.devices.push({deviceId,status:'unchanged'});
    error.rollback=report;error.completed=completed;throw error;
  }finally{
    const failures=[];
    for(const resource of locks.reverse())try{await client.request('POST',resource,{type:'Unlock'});}catch(e){failures.push({resource,error:e.message});}
    if(failures.length){report.errors.push(...failures.map(f=>`Unlock ${f.resource}: ${f.error}`));report.status='incomplete';}
  }
}
