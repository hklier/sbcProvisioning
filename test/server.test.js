import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
test('web API: CSRF, preview/apply, search, OL agents, LRT update and consumed previews',async t=>{
  const child=spawn(process.execPath,['server.js'],{cwd:fileURLToPath(new URL('..',import.meta.url)),env:{...process.env,PORT:'0',HOST:'127.0.0.1',APP_PASSWORD:''},stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill());
  const [output]=await once(child.stdout,'data');const base=String(output).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];assert.ok(base,'server started');
  const initial=await fetch(base+'/api/status');const cookie=initial.headers.get('set-cookie').split(';')[0];const state=await initial.json();
  const post=async(route,data,csrf=state.csrf)=>{const r=await fetch(base+'/api/'+route,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(data)});return {status:r.status,data:await r.json()};};
  const run=async(route,data)=>{const start=await post(route,data);assert.equal(start.status,202,JSON.stringify(start.data));for(let i=0;i<200;i++){const job=await (await fetch(base+'/api/jobs/'+start.data.jobId,{headers:{Cookie:cookie}})).json();if(job.status!=='running')return job;await new Promise(r=>setTimeout(r,10));}throw new Error('Test job timed out');};
  assert.equal((await post('connect',{mode:'demo'},'wrong')).status,403);
  assert.equal((await run('connect',{mode:'demo'})).status,'complete');
  const input={mode:'OC',configAction:'update',deviceIds:['ID8'],bgid:'1227100253',sipPort:'6005',sipAddress:'10.229.189.129',includeLrt:true,routeSetId:'2',rangeStart:'371542590',rangeEnd:'371542592',scope:'both'};
  const duplicate=await run('preview',{...input,configAction:'create'});assert.equal(duplicate.status,'failed');assert.match(duplicate.error,/already exists/);
  const preview=await run('preview',input);assert.equal(preview.status,'complete',preview.error);assert.equal(preview.result.configurations[0].operations[1].method,'POST');
  assert.ok(preview.logs.some(l=>l.method==='GET' && l.url.endsWith('/routeSets/')),'every preview refreshes route set versions rather than using cached connection inventory');
  const applied=await run('apply',{planId:preview.result.id});assert.equal(applied.status,'complete',applied.error);assert.equal(applied.result.completed.length,3);assert.ok(applied.logs.some(l=>l.request?.type==='Commit'));assert.ok(applied.logs.some(l=>l.request?.type==='Unlock'));
  assert.deepEqual(applied.result.changeCalls.map(c=>new URL(c.url).pathname.replace('/rest/v1.3','')),[
    '/configuration/deviceConfigs/ID8/configElements/delete','/configuration/deviceConfigs/ID8/configElements/delete',
    '/configuration/deviceConfigs/ID8/configElements/add','/configuration/deviceConfigs/ID8/configElements/add',
    '/configuration/devices/ID8/action','/routeSets/2/entries/','/routeSets/2/devices/action','/routeSets/routeUpdates/DEMO-UPDATE-2/action'
  ]);
  assert.ok(applied.result.changeCalls.every(c=>c.method==='POST' && c.status>=200 && c.status<300 && Object.hasOwn(c,'response')));
  assert.equal((await run('apply',{planId:preview.result.id})).status,'failed');
  const search=await run('search',{deviceId:'ID8',mode:'OC',type:'all',filter:'1227100253',routeSetId:'2'});assert.equal(search.status,'complete',search.error);assert.equal(search.result.objects.length,2);assert.equal(search.result.routes.length,2);
  const ol={mode:'OL',deviceIds:['ID8'],customerIdentifier:'CUSTOMER2',customerCli:'372818574',lrtCustomerId:'152970402130005',agentIps:['172.22.250.230','172.22.250.231'],includeLrt:true,routeSetId:'3',numberLength:'9',rangeStart:'372818574',rangeEnd:'372818576',scope:'both'};
  const olPreview=await run('preview',ol);assert.equal(olPreview.status,'complete',olPreview.error);assert.equal(olPreview.result.configurations[0].operations.length,4);assert.ok(olPreview.result.configurations[0].operations.every(op=>op.path.endsWith('/add')));
  const olApplied=await run('apply',{planId:olPreview.result.id});assert.equal(olApplied.status,'complete');assert.equal(olApplied.logs.filter(l=>l.url.endsWith('/configElements/add')).length,4);assert.ok(!olApplied.logs.some(l=>l.url.endsWith('/configElements/update')));
  const olSearch=await run('search',{deviceId:'ID8',mode:'OL',type:'all',filter:'CUSTOMER2',routeSetId:'3'});assert.equal(olSearch.result.routes.length,1,'resolves numeric LRT ID through hmrString');
  const numericSearch=await run('search',{deviceId:'ID8',mode:'OL',type:'all',filter:'152970402130005',routeSetId:'3'});assert.equal(numericSearch.result.objects.length,3);assert.equal(numericSearch.result.routes.length,1);
  const row=olSearch.result.routes[0];const edited=await run('preview',{kind:'routeEdit',scope:'lrt',deviceIds:['ID8'],routeSetId:'3',entryId:row.objectId,route:{...row,sed:row.sed.replace('+40','+4037281')}});assert.equal(edited.status,'complete',edited.error);assert.equal(edited.result.route.method,'PUT');assert.equal((await run('apply',{planId:edited.result.id})).status,'complete');
  const missingAssociation={...input,deviceIds:['ID6'],scope:'lrt',rangeStart:'371542600',rangeEnd:'371542601'};
  const denied=await run('preview',missingAssociation);assert.equal(denied.status,'failed');assert.match(denied.error,/not associated/);
  const associationPlan=await run('preview',{...missingAssociation,associateTarget:true});assert.equal(associationPlan.status,'complete',associationPlan.error);assert.equal(associationPlan.result.associations[0].body.assocDevices[0].deviceGroupId,'ID12');
  const associationApplied=await run('apply',{planId:associationPlan.result.id});assert.equal(associationApplied.status,'complete',associationApplied.error);assert.ok(associationApplied.logs.some(l=>l.request?.assocDevices?.[0]?.deviceGroupId==='ID12'));
  const both={...input,configAction:'create',bgid:'9876543210',scope:'config',deviceIds:['ID8','ID6'],sipAddresses:{ID8:'10.229.189.129',ID6:'10.229.189.130'},includeLrt:false,demoFailure:'activate-second'};
  for(const sipAddresses of [undefined,{ID8:'10.229.189.129'},{ID8:'10.229.189.129',ID6:'bad-ip'},{ID8:'10.229.189.129',ID6:'10.229.189.129'}]) {
    const denied=await run('preview',{...both,sipAddresses});assert.equal(denied.status,'failed');assert.match(denied.error,/SIP interface IP/);assert.ok(denied.logs.every(l=>l.method==='GET'),'invalid addresses are rejected before staging requests');
  }
  const bothPreview=await run('preview',both);assert.equal(bothPreview.status,'complete',bothPreview.error);
  const ips=object=>(object.childrenElements || []).filter(c=>c.elementTypePath==='sipInterface/sipPort').map(c=>c.attributes.find(a=>a.name==='address').value);
  for(const c of bothPreview.result.configurations)assert.deepEqual(ips(c.operations.find(o=>o.body.elementTypePath==='sipInterface').body),[both.sipAddresses[c.deviceId],both.sipAddresses[c.deviceId]]);
  const failed=await run('apply',{planId:bothPreview.result.id});assert.equal(failed.status,'failed');assert.equal(failed.failure.rollback.status,'restored');assert.equal(failed.failure.rollback.devices.length,2);assert.ok(failed.failure.failedCalls.length);
  const again=await run('preview',{...both,demoFailure:''});assert.equal(again.status,'complete',again.error);assert.equal((await run('apply',{planId:again.result.id})).status,'complete');
  const addresses={ID8:'10.229.189.131',ID6:'10.229.189.132'};
  const updated=await run('preview',{...both,configAction:'update',sipAddresses:addresses,demoFailure:''});assert.equal(updated.status,'complete',updated.error);
  assert.ok(updated.result.configurations.every(c=>c.operations.every(o=>o.path.endsWith('/update'))));assert.equal((await run('apply',{planId:updated.result.id})).status,'complete');
  const findSip=async deviceId=>{const search=await run('search',{deviceId,mode:'OC',type:'sipInterface',filter:both.bgid});assert.equal(search.status,'complete',search.error);return search.result.objects[0];};
  for(const deviceId of both.deviceIds)assert.deepEqual(ips(await findSip(deviceId)),[addresses[deviceId],addresses[deviceId]]);
  const edit=await run('preview',{kind:'edit',scope:'config',deviceIds:both.deviceIds,object:await findSip('ID8'),sipAddresses:{ID8:'10.229.189.141',ID6:'10.229.189.142'},demoFailure:'activate-second'});assert.equal(edit.status,'complete',edit.error);
  const editFailed=await run('apply',{planId:edit.result.id});assert.equal(editFailed.status,'failed');assert.equal(editFailed.failure.rollback.status,'restored');
  for(const deviceId of both.deviceIds)assert.deepEqual(ips(await findSip(deviceId)),[addresses[deviceId],addresses[deviceId]],'rollback restores each device original address');
  const deletion=await run('preview',{kind:'delete',mode:'OC',filter:'9876543210',scope:'config',deviceIds:['ID8','ID6']});assert.equal(deletion.status,'complete',deletion.error);assert.equal(deletion.result.configurations[0].operations.length,2);assert.ok(deletion.result.configurations.every(c=>c.operations.every(o=>o.path.endsWith('/delete'))));const deleted=await run('apply',{planId:deletion.result.id});assert.equal(deleted.status,'complete');assert.equal(deleted.result.changeCalls.length,6);assert.equal(deleted.result.changeCalls.filter(c=>c.url.endsWith('/configElements/delete')).length,4);
  const olDelete=await run('preview',{kind:'delete',mode:'OL',filter:'CUSTOMER2',scope:'both',routeSetId:'3',deviceIds:['ID8']});assert.equal(olDelete.status,'complete',olDelete.error);const olDeleted=await run('apply',{planId:olDelete.result.id});assert.equal(olDeleted.status,'complete',olDeleted.error);assert.ok(olDeleted.result.changeCalls.some(c=>c.method==='DELETE' && c.url.includes('/routeSets/3/entries/')));assert.ok(olDeleted.result.changeCalls.every(c=>c.method!=='GET' && !c.url.endsWith('/retrieve')));
});
