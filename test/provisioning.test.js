import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generate,attr,element,merge,selector,locked,applyConfig,deployRoutes,resolveRoute,resolveObjects } from '../lib/provisioning.js';
import { SdmClient,redact } from '../lib/sdm.js';
const oc={mode:'OC',bgid:'1227100253',sipPort:'6000',sipAddress:'10.229.189.129',includeLrt:true,routeSetId:'2',rangeStart:'371542577',rangeEnd:'371542579'};
const ol={mode:'OL',customerIdentifier:'N529704BUCPE4',customerCli:'372818574',lrtCustomerId:'152970402130004',agentIps:['172.22.250.226','172.22.250.227','172.22.250.228','172.22.250.229'],includeLrt:true,routeSetId:'3',numberLength:'9',rangeStart:'372818574',rangeEnd:'372818576'};
test('new configuration elements are sent to POST /add for all supported types',async()=>{
  const objects=[...generate(oc).objects,...generate(ol).objects.slice(1),element('localPolicy',{},[element('localPolicy/from',{addr:'*'}),element('localPolicy/to',{addr:'123'}),element('localPolicy/sourceRealm',{name:'access'})])];
  const calls=[];const client={list:async()=>[],request:async(m,p,b)=>{calls.push({m,p,b});return {status:'SUCCESS'};}};
  const ops=await resolveObjects(client,'ID8',objects);
  await applyConfig(client,'ID8',ops);
  assert.equal(ops.length,8);assert.ok(ops.every(op=>op.method==='POST' && op.path==='/configuration/deviceConfigs/ID8/configElements/add'));
  assert.equal(calls.filter(c=>c.p.endsWith('/add')).length,8);assert.ok(!calls.some(c=>c.p.endsWith('/update')));
});
test('create rejects duplicate keys; update requires an existing key; auto remains explicit',async()=>{
  const object=element('realmConfig',{id:'customer'});const client={list:async()=>[object],request:async()=>object};
  await assert.rejects(resolveObjects(client,'ID8',[object]),/already exists/);
  const update=await resolveObjects(client,'ID8',[object],'update');assert.ok(update[0].path.endsWith('/update'));
  const mixed=await resolveObjects(client,'ID8',[object,element('realmConfig',{id:'new'})],'auto');assert.deepEqual(mixed.map(op=>op.path.split('/').at(-1)),['update','add']);
  client.list=async()=>[];await assert.rejects(resolveObjects(client,'ID8',[object],'update'),/does not exist/);
});
test('OC naming, both SIP transports, exact string LRT keys and regex backreference',()=>{
  const p=generate(oc);assert.equal(p.realm,'core-oc-bgid1227100253');assert.equal(p.objects.length,2);
  assert.deepEqual(p.objects[1].childrenElements.map(e=>[attr(e,'port'),attr(e,'transProtocol')]),[['6000','TCP'],['6000','UDP']]);
  assert.equal(p.route.rangeStart,'1227100253371542577');assert.equal(p.route.rangeEnd,'1227100253371542579');assert.equal(p.route.sed,'!(^.*$)!sip:\\1;area=021@grp-prio-buoc-cscf;egress=core-oc-bgid1227100253!');
  assert.ok(!p.objects.some(o=>o.elementTypePath==='localPolicy'));
});
test('OL shares numeric manipulation/LRT value and generates four agents and group members',()=>{
  const p=generate(ol);assert.equal(p.realm,'N529704BUCPE4-access');assert.equal(attr(p.objects[0],'hmrString'),ol.lrtCustomerId);
  const agents=p.objects.filter(e=>e.elementTypePath==='sessionAgent');assert.equal(agents.length,4);assert.equal(attr(agents[3],'hostname'),'N529704BUCPE4-4');assert.equal(attr(agents[3],'ipAddress'),'172.22.250.229');
  assert.equal(attr(agents[0],'realmID'),'access-ol-sbc');assert.equal(p.route.rangeStart,'1529704021300049372818574');assert.equal(p.route.sed,'!(^.*$)!sip:\\1;area=021;prefix=+40@grp-prio-buol-cscf!');
  assert.equal(p.objects.at(-1).childrenElements.filter(e=>e.elementTypePath.endsWith('/sipDest')).length,4);
});
test('validation rejects bad ports, IPs, too many agents, invalid ranges and length',()=>{
  for(const patch of [{sipPort:'0'},{sipPort:'65536'},{sipAddress:'bad'},{rangeEnd:'371542570'},{bgid:'bad'}])assert.throws(()=>generate({...oc,...patch}));
  assert.throws(()=>generate({...ol,agentIps:['1.2.3.4','1.2.3.4']}));assert.throws(()=>generate({...ol,agentIps:Array(5).fill('1.2.3.4')}));assert.throws(()=>generate({...ol,numberLength:'8'}));
});
test('LRT-only generation does not require SIP or agent provisioning inputs',()=>{
  assert.equal(generate({...oc,scope:'lrt',sipPort:'',sipAddress:''}).objects.length,0);
  assert.equal(generate({...ol,scope:'lrt',agentIps:[],customerCli:''}).objects.length,0);
});
test('merge preserves unrelated settings and replaces desired child collections',()=>{
  const old=element('sipInterface',{RealmID:'abc',custom:'keep',lastModifiedBy:'admin'},[element('sipInterface/sipPort',{port:'5060'}),element('sipInterface/other',{x:1})]);
  const updated=merge(old,element('sipInterface',{RealmID:'abc'},[element('sipInterface/sipPort',{port:'6000'})]));
  assert.equal(attr(updated,'custom'),'keep');assert.equal(attr(updated,'lastModifiedBy'),undefined);assert.equal(updated.childrenElements.length,2);assert.equal(attr(updated.childrenElements[1],'port'),'6000');
});
test('local-policy selector needs its composite keys',()=>assert.throws(()=>selector(element('localPolicy'))));
test('unlock is attempted after staging fails, but never after failed lock acquisition',async()=>{
  let calls=[];const client={request:async(m,p,b)=>{calls.push(b.type);}};
  await assert.rejects(locked(client,'/lock',()=>{throw new Error('failure');}),/failure/);assert.deepEqual(calls,['Lock','Unlock']);
  calls=[];client.request=async(m,p,b)=>{calls.push(b.type);throw new Error('already locked');};await assert.rejects(locked(client,'/lock',()=>{}));assert.deepEqual(calls,['Lock']);
});
test('HTTP 200 with failed activation is not treated as success',async()=>{
  const client={request:async()=>({status:'SUCCESS',isActivateConfigSuccess:'FAILED'})};await assert.rejects(applyConfig(client,'ID8',[]),/did not confirm/);
});
test('LRT commit happens only after completed push; failures request rollback',async()=>{
  const calls=[];let poll=0;const client={request:async(m,p,b)=>{calls.push({m,p,b});if(p.endsWith('/devices/action'))return{objectId:'ID42'};if(m==='GET')return{updateStatus:++poll===1?'In Progress':'Completed',deviceStatusList:poll===1?[]:[{status:'Completed',pushStatus:'Completed'}]};}};
  await deployRoutes(client,'2',['ID14'],{sleep:async()=>{}});assert.equal(calls.at(-1).b.type,'Commit');assert.equal(calls[0].b.deviceGroups.deviceGroup.deviceGroupId,'ID14');
  calls.length=0;client.request=async(m,p,b)=>{calls.push({m,p,b});return p.endsWith('/devices/action')?{objectId:'ID43'}:{updateStatus:'Failed'};};await assert.rejects(deployRoutes(client,'2',['ID14']),/failed/);assert.equal(calls.at(-1).b.type,'Rollback');
});
test('range overlap uses exact integers above JavaScript safe integer range',async()=>{
  const client={list:async()=>[{objectId:'ID1',rangeStart:'1227100253371542577',rangeEnd:'1227100253371542579',sed:'old'}]};
  await assert.rejects(resolveRoute(client,'2',{rangeStart:'1227100253371542578',rangeEnd:'1227100253371542580',sed:'new'}),/overlaps/);
  const op=await resolveRoute(client,'2',{rangeStart:'1227100253371542577',rangeEnd:'1227100253371542579',sed:'new'});assert.equal(op.method,'PUT');assert.equal(op.body.sed,'new');assert.equal(op.body.objectId,undefined);
});
test('real transport keeps login cookie and masks passwords/session IDs; pagination reads beyond page one',async t=>{
  const seen=[],logs=[];const server=http.createServer((req,res)=>{seen.push(req.headers.cookie);res.setHeader('Content-Type','application/json');if(req.url==='/admin/login'){res.setHeader('Set-Cookie','JSESSIONID=very-secret-session; Path=/rest; HttpOnly');return res.end(JSON.stringify({sessionId:'very-secret-session'}));}const offset=Number(new URL(req.url,'http://local').searchParams.get('offset'));res.end(JSON.stringify({items:offset===1?[1,2]:offset===3?[3]:[],pageInfo:{limitation:2,offset}}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const client=new SdmClient({baseUrl:`http://127.0.0.1:${server.address().port}`,credentials:{userName:'test',password:'very-secret-password'},onLog:x=>logs.push(x)});await client.login();assert.deepEqual(await client.list('/items','items'),[1,2,3]);assert.equal(seen[1],'JSESSIONID=very-secret-session');assert.doesNotMatch(JSON.stringify(logs),/very-secret/);
});
test('redaction removes nested credentials and literal known secrets',()=>assert.deepEqual(redact({password:'x',response:{sessionId:'y'},error:'token is abc'},['abc']),{password:'[redacted]',response:{sessionId:'[redacted]'},error:'token is [redacted]'}));
