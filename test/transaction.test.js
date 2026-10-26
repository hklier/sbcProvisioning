import test from 'node:test';
import assert from 'node:assert/strict';
import {DemoClient} from '../lib/demo.js';
import {generate,resolveObjects,fingerprint,attr,element} from '../lib/provisioning.js';
import {prepareDeletion,customerObjects} from '../lib/deletion.js';
import {executeTransaction,normalized} from '../lib/transaction.js';
const devices=[{id:'ID8',nfId:'ID14'},{id:'ID6',nfId:'ID12'}];
const contents=client=>fingerprint([...client.runningConfigs].map(([d,e])=>[d,e.map(normalized).sort((a,b)=>fingerprint(a).localeCompare(fingerprint(b)))]));
async function plan(client,input={}) {
  const objects=generate({mode:'OC',bgid:'1234567890',sipPort:'6500',sipAddress:'10.229.189.129',...input}).objects;
  return {deviceIds:['ID8','ID6'],groupIds:['ID14','ID12'],configurations:await Promise.all(devices.map(async d=>({deviceId:d.id,operations:await resolveObjects(client,d.id,objects,input.configAction || 'create')}))),routes:[],associations:[]};
}
test('second activation failure restores both running configurations and clears all staging/locks',async()=>{
  const client=new DemoClient(()=>{});const before=contents(client);const p=await plan(client);
  client.failure='activate-second';client.failureDevice='ID6';
  await assert.rejects(executeTransaction(client,p),error=>{assert.equal(error.rollback.status,'restored');assert.deepEqual(error.rollback.devices.map(d=>d.status),['restored','restored']);return true;});
  assert.equal(contents(client),before);assert.equal(client.locks.size,0);assert.equal(fingerprint([...client.configs]),fingerprint([...client.runningConfigs]));
});
test('failure after SDM applied activation but before response also restores both targets',async()=>{
  const client=new DemoClient(()=>{});const before=contents(client);const p=await plan(client);const request=client.request.bind(client);let failed=false;
  client.request=async(m,path,b)=>{const result=await request(m,path,b);if(!failed && path==='/configuration/devices/ID6/action'){failed=true;throw new Error('Connection closed after apply');}return result;};
  await assert.rejects(executeTransaction(client,p),e=>e.rollback.status==='restored');assert.equal(contents(client),before);
});
test('OC deletion removes exact customer configuration on both devices, leaves other customers intact',async()=>{
  const client=new DemoClient(()=>{});const p={...await prepareDeletion(client,devices,{mode:'OC',filter:'1227100253',scope:'config'}),deviceIds:['ID8','ID6'],groupIds:['ID14','ID12'],associations:[]};
  assert.deepEqual(p.configurations.map(c=>c.operations.length),[2,2]);await executeTransaction(client,p);
  for(const rows of client.runningConfigs.values()){assert.ok(!rows.some(e=>attr(e,'id')==='core-oc-bgid1227100253'));assert.ok(rows.some(e=>attr(e,'id')==='N529704BUCPE4-access'));}
});
test('OL numeric deletion resolves exact naming ID; partial names do not select customers',async()=>{
  const client=new DemoClient(()=>{});const rows=client.configs.get('ID8');
  assert.equal(customerObjects(rows,'OL','152970402130004').objects.length,3);
  assert.equal(customerObjects(rows,'OL','N529704').objects.length,0);
  assert.throws(()=>customerObjects(rows,'OL','N529704BUCPE4','9999'),/Ambiguous/);
  const unrelated=element('sessionAgent',{hostname:'global-agent',hmrString:'152970402130004'});
  assert.equal(customerObjects([...rows,unrelated],'OL','N529704BUCPE4').objects.length,3);
  const p={...await prepareDeletion(client,devices,{mode:'OL',filter:'152970402130004',scope:'config'}),deviceIds:['ID8','ID6'],groupIds:['ID14','ID12'],associations:[]};
  const before=contents(client);client.failure='activate-second';client.failureDevice='ID6';await assert.rejects(executeTransaction(client,p),e=>e.rollback.status==='restored');assert.equal(contents(client),before);
});
test('LRT push failure restores deleted entries, both SBC configurations and device routing tables',async()=>{
  const client=new DemoClient(()=>{});client.associations.get('3').push({deviceGroupId:'ID12'});
  const before=contents(client),routes=fingerprint(client.entries.get('3').map(r=>{const {objectId,...rest}=r;return rest;}));
  const p={...await prepareDeletion(client,devices,{mode:'OL',filter:'N529704BUCPE4',scope:'both',routeSetId:'3'}),deviceIds:['ID8','ID6'],groupIds:['ID14','ID12'],routeSetId:'3',routeBaselineVerified:true,associations:[]};
  client.failure='lrt-push';await assert.rejects(executeTransaction(client,p,{sleep:async()=>{}}),e=>{assert.equal(e.rollback.status,'restored',JSON.stringify(e.rollback));return true;});
  assert.equal(contents(client),before);assert.equal(fingerprint(client.entries.get('3').map(({objectId,...rest})=>rest)),routes);
  for(const tables of client.deployedRoutes.values())assert.equal(fingerprint(tables.get('3').map(({objectId,...rest})=>rest)),routes);
});
test('failed restoration is reported as incomplete while recovery continues for the other target',async()=>{
  const client=new DemoClient(()=>{});const p=await plan(client);const request=client.request.bind(client);let triggered=false;
  client.request=async(m,path,b)=>{if(path==='/configuration/devices/ID6/action' && !triggered){triggered=true;throw new Error('activation failed');}if(triggered && path==='/configuration/deviceConfigs/ID6/configurationChanges')throw new Error('recovery unavailable');return request(m,path,b);};
  await assert.rejects(executeTransaction(client,p),e=>{assert.equal(e.rollback.status,'incomplete');assert.ok(e.rollback.devices.some(d=>d.deviceId==='ID8' && d.status==='restored'));assert.ok(e.rollback.errors.length);return true;});
});
test('new route associations are compensated and only acquired locks are released',async()=>{
  const client=new DemoClient(()=>{});const p=await plan(client);p.associations=[{method:'POST',path:'/routeSets/2/devices/',body:{assocDevices:[{deviceGroupId:'ID12'}]}}];
  const initial=fingerprint([...client.associations]);client.failure='activate-second';client.failureDevice='ID6';await assert.rejects(executeTransaction(client,p),e=>e.rollback.status==='restored');assert.equal(fingerprint([...client.associations]),initial);assert.equal(client.locks.size,0);
});
test('lock acquisition failure performs no mutations and never unlocks another owner’s resource',async()=>{
  const client=new DemoClient(()=>{});const p=await plan(client);client.locks.add('/inventory/deviceMgmt/devices/ID8/action');const before=contents(client);
  await assert.rejects(executeTransaction(client,p),e=>e.rollback.status==='not-needed');assert.equal(contents(client),before);assert.equal(client.locks.size,1);
});
test('a failed LRT push task restores each target original table through native rollback',async()=>{
  const client=new DemoClient(()=>{});const before=contents(client);const p=await plan(client);
  const original=structuredClone(client.entries.get('2'));p.routeSetId='2';p.routeSnapshot=original;p.routes=[{method:'PUT',path:'/routeSets/2/entries/ID1',body:{...original[0],sed:'changed'},before:original[0]}];
  const request=client.request.bind(client);let failed=false;
  client.request=async(m,path,b)=>{const result=await request(m,path,b);if(!failed && m==='GET' && path.includes('/routeUpdates/')){failed=true;return {...result,updateStatus:'Failed'};}return result;};
  await assert.rejects(executeTransaction(client,p,{sleep:async()=>{}}),e=>{assert.equal(e.rollback.status,'restored',JSON.stringify(e.rollback));assert.equal(e.rollback.routeUpdates[0].status,'rolled-back');return true;});
  assert.equal(contents(client),before);for(const tables of client.deployedRoutes.values())assert.equal(tables.get('2')[0].sed,original[0].sed);
});
test('unknown LRT push outcome without a verified baseline is incomplete, never silently overwritten',async()=>{
  const client=new DemoClient(()=>{});const p=await plan(client);const original=structuredClone(client.entries.get('2'));
  p.routeSetId='2';p.routeSnapshot=original;p.routes=[{method:'DELETE',path:'/routeSets/2/entries/ID1',before:original[0]}];client.failure='lrt-push';
  await assert.rejects(executeTransaction(client,p,{sleep:async()=>{}}),e=>{assert.equal(e.rollback.status,'incomplete');assert.ok(e.rollback.errors.some(s=>s.includes('No verified common')));return true;});
  assert.equal(client.routeTasks.size,0);
});
test('updates restore original SIP ports on both targets after the second activation fails',async()=>{
  const client=new DemoClient(()=>{});const before=contents(client);const p=await plan(client,{bgid:'1227100253',configAction:'update'});
  client.failure='activate-second';client.failureDevice='ID6';await assert.rejects(executeTransaction(client,p),e=>e.rollback.status==='restored');assert.equal(contents(client),before);
});
test('already completed SDM automatic LRT rollback is verified without requesting it again',async()=>{
  const client=new DemoClient(()=>{});const p=await plan(client);const original=structuredClone(client.entries.get('2'));
  p.routeSetId='2';p.routeSnapshot=original;p.routes=[{method:'DELETE',path:'/routeSets/2/entries/ID1',before:original[0]}];
  const request=client.request.bind(client);let auto=false,manualCalls=0;
  client.request=async(m,path,b)=>{
    if(auto && m==='POST' && b?.type==='Rollback'){manualCalls++;throw new Error('SDM already rolled back this task');}
    if(!auto && m==='GET' && path.includes('/routeUpdates/')){auto=true;await request('POST',path+'/action',{type:'Rollback'});const r=await request(m,path,b);return {...r,updateStatus:'Failed'};}
    return request(m,path,b);
  };
  await assert.rejects(executeTransaction(client,p,{sleep:async()=>{}}),e=>e.rollback.status==='restored');assert.equal(manualCalls,0);
});
