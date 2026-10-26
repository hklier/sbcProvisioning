import test from 'node:test';
import assert from 'node:assert/strict';
import {DemoClient} from '../lib/demo.js';
import {element,attr,generate,resolveObjects,configUpdateRequests,fingerprint} from '../lib/provisioning.js';
import {executeTransaction,normalized} from '../lib/transaction.js';
import {previewDigest} from '../lib/preview.js';
const input={mode:'OC',bgid:'1227100253',sipPort:'6500',sipAddress:'192.0.2.20'};
const state=c=>fingerprint([...c.runningConfigs].map(([d,rows])=>[d,rows.map(normalized)]));
const single=e=>{assert.ok((e.childrenElements || []).length<=1);for(const child of e.childrenElements || [])single(child);};

test('realm update keeps unchanged sibling children out of the update payload',async()=>{
 const c=new DemoClient(()=>{}),old=generate(input).objects[0],desired=structuredClone(old);
 desired.attributes.push({name:'description',value:'Updated realm'});
 const requests=await configUpdateRequests(c,'ID8',old,desired);
 assert.equal(requests.length,1);assert.ok(requests[0].path.endsWith('/update'));assert.equal(requests[0].body.childrenElements,undefined);
 assert.equal(attr(requests[0].body,'id'),'core-oc-bgid1227100253');assert.equal(attr(requests[0].body,'description'),'Updated realm');
});

test('each SIP port key change targets only the child, never deletes the interface',async()=>{
 const c=new DemoClient(()=>{}),before=state(c),old=c.configs.get('ID8').find(e=>e.elementTypePath==='sipInterface');
 const ops=await resolveObjects(c,'ID8',[generate(input).objects[1]],'update'),requests=ops[0].requests;
 assert.deepEqual(requests.map(r=>r.path.split('/').at(-1)),['delete','delete','add','add']);
 for(const r of requests){assert.equal(r.body.elementTypePath,'sipInterface/sipPort');assert.equal(attr(r.body.parentElement,'RealmID'),attr(old,'RealmID'));}
 await executeTransaction(c,{deviceIds:['ID8'],groupIds:[],configurations:[{deviceId:'ID8',operations:ops}],routes:[]});
 assert.notEqual(state(c),before);const actual=c.runningConfigs.get('ID8').find(e=>e.elementTypePath==='sipInterface');assert.equal(actual.childrenElements.length,2);assert.ok(actual.childrenElements.every(e=>attr(e,'port')==='6500' && attr(e,'address')==='192.0.2.20'));
});

test('matching child updates use one branch and preserve unrelated child defaults',async()=>{
 const c=new DemoClient(()=>{}),old=c.configs.get('ID8').find(e=>e.elementTypePath==='sipInterface');
 old.childrenElements[0].attributes.push({name:'customSetting',value:'keep'});
 const desired=structuredClone(old);desired.childrenElements[0].attributes.find(a=>a.name==='anonMode').value='all';
 const requests=await configUpdateRequests(c,'ID8',old,desired);assert.equal(requests.length,1);single(requests[0].body);
 await c.request(requests[0].method,requests[0].path,requests[0].body);
 assert.equal(old.childrenElements.length,2);const actual=c.configs.get('ID8').find(e=>e.elementTypePath==='sipInterface');assert.equal(attr(actual.childrenElements[0],'customSetting'),'keep');assert.equal(attr(actual.childrenElements[0],'anonMode'),'all');
});

test('unchanged generated child attributes do not rewrite SDM defaults or require activation',async()=>{
 const c=new DemoClient(()=>{}),old=c.configs.get('ID8').find(e=>e.elementTypePath==='sipInterface');
 old.childrenElements[0].attributes.push({name:'customSetting',value:'keep'});
 const desired=generate({...input,sipPort:'6000',sipAddress:'10.229.189.129'}).objects[1];
 assert.deepEqual(await configUpdateRequests(c,'ID8',old,desired),[]);
});

test('rollback of a rejected first update does not activate an unchanged configuration',async()=>{
 const c=new DemoClient(()=>{}),before=state(c),old=generate(input).objects[0];old.attributes.push({name:'description',value:'new'});
 const operations=await resolveObjects(c,'ID8',[old],'update'),request=c.request.bind(c);let rejected=false,activations=0;
 c.request=async(m,p,b)=>{if(p.endsWith('/update')&&!rejected){rejected=true;throw Error('SDM rejected update');}if(b?.type==='SaveActivateConfig'){activations++;throw Error('No user changes found');}return request(m,p,b);};
 await assert.rejects(executeTransaction(c,{deviceIds:['ID8'],groupIds:[],configurations:[{deviceId:'ID8',operations}],routes:[]}),e=>{assert.equal(e.rollback.status,'restored');return true;});
 assert.equal(activations,0);assert.equal(state(c),before);assert.equal(c.locks.size,0);
});

test('a partially applied SIP child change and second activation failure restore both targets',async()=>{
 for(const failure of ['lost-child-response','activate-second']) {
  const c=new DemoClient(()=>{}),before=state(c),configurations=[];
  for(const deviceId of ['ID8','ID6'])configurations.push({deviceId,operations:await resolveObjects(c,deviceId,generate(input).objects,'update')});
  if(failure==='activate-second'){c.failure=failure;c.failureDevice='ID6';}
  else {const request=c.request.bind(c);let failed=false;c.request=async(m,p,b)=>{const result=await request(m,p,b);if(!failed&&p.endsWith('/delete')&&b.elementTypePath==='sipInterface/sipPort'){failed=true;throw Error('Response lost after deleting child');}return result;};}
  await assert.rejects(executeTransaction(c,{deviceIds:['ID8','ID6'],groupIds:[],configurations,routes:[]}),e=>e.rollback.status==='restored');
  assert.equal(state(c),before);assert.equal(c.locks.size,0);
 }
});

test('OL group member replacement preserves the parent and four-member recovery',async()=>{
 const c=new DemoClient(()=>{}),old=c.configs.get('ID8').find(e=>e.elementTypePath==='sessionAgentGroup'),desired=structuredClone(old);
 desired.childrenElements.unshift(element('sessionAgentGroup/sipDest',{name:'N529704BUCPE4-2'}));
 const requests=await configUpdateRequests(c,'ID8',old,desired);assert.equal(requests.length,1);assert.equal(requests[0].body.elementTypePath,'sessionAgentGroup/sipDest');assert.equal(requests[0].body.parentElement.elementTypePath,'sessionAgentGroup');
 await c.request(requests[0].method,requests[0].path,requests[0].body);assert.equal(old.childrenElements.filter(e=>e.elementTypePath.endsWith('/sipDest')).length,2);
 const restore=await configUpdateRequests(c,'ID8',old,generate({mode:'OL',customerIdentifier:'N529704BUCPE4',customerCli:'1',lrtCustomerId:'152970402130004',agentIps:['192.0.2.10']}).objects.at(-1));
 for(const r of restore)await c.request(r.method,r.path,r.body);assert.equal(old.childrenElements.filter(e=>e.elementTypePath.endsWith('/sipDest')).length,1);
});

test('metadata failure prevents preparing a partial child update, and preview includes parent selectors',async()=>{
 const c=new DemoClient(()=>{}),old=c.configs.get('ID8').find(e=>e.elementTypePath==='sipInterface');
 await assert.rejects(configUpdateRequests({request:async()=>({})},'ID8',old,generate(input).objects[1]),/Cannot determine SDM child keys/);
 const requests=await configUpdateRequests(c,'ID8',old,generate(input).objects[1]);
 const plan={configurations:[{deviceId:'ID8',operations:[{body:old,before:old,requests}]}]},changed=structuredClone(plan);
 changed.configurations[0].operations[0].requests[0].body.parentElement.attributes[0].value='different';assert.notEqual(previewDigest(plan),previewDigest(changed));
});
