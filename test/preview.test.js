import test from 'node:test';
import assert from 'node:assert/strict';
import {element} from '../lib/provisioning.js';
import {previewDigest,changedSections} from '../lib/preview.js';
const fixture=()=>({configurations:[{deviceId:'ID8',operations:[{method:'POST',path:'/configElements/delete',body:element('realmConfig',{id:'core-oc-bgid9988776655'}),before:element('realmConfig',{id:'core-oc-bgid9988776655',parent:'core-oc-sbc',lastModifiedDate:'old',dataVersion:'1'})}]}],routes:[{method:'DELETE',path:'/entries/42',before:{objectId:'42',rangeStart:'998877665510',rangeEnd:'998877665519',sed:'route'}}],routeSnapshot:[{objectId:'42',rangeStart:'998877665510',rangeEnd:'998877665519',sed:'route'}],deviceIds:['ID8'],groupIds:['ID14'],routeSetId:'7',routeBaselineVerified:true,associations:[]});
test('preview ignores SDM bookkeeping and JSON property/attribute/list order without changing snapshots',()=>{
  const a=fixture(),b=structuredClone(a),original=JSON.stringify(a);
  const attrs=b.configurations[0].operations[0].before.attributes;
  attrs.find(x=>x.name==='lastModifiedDate').value='new';attrs.find(x=>x.name==='dataVersion').value='2';attrs.reverse();
  b.routes[0].before={sed:'route',rangeEnd:'998877665519',rangeStart:'998877665510',objectId:'42'};
  a.routeSnapshot.push({objectId:'43',rangeStart:'20',rangeEnd:'21',sed:'other'});b.routeSnapshot.unshift({sed:'other',rangeEnd:'21',rangeStart:'20',objectId:'43'});
  assert.equal(previewDigest(a),previewDigest(b));assert.deepEqual(changedSections(a,b),[]);
  a.routeSnapshot.pop();assert.equal(JSON.stringify(a),original);
});
test('preview still rejects configuration, route, identity, target and baseline changes',()=>{
  const a=fixture();
  for(const mutate of [b=>b.configurations[0].operations[0].before.attributes[1].value='different',b=>b.configurations[0].operations[0].body.attributes[0].value='different',b=>b.routes[0].before.sed='different',b=>b.routeSnapshot[0].objectId='99',b=>b.deviceIds.push('ID6'),b=>b.routeBaselineVerified=false]){
    const b=structuredClone(a);mutate(b);assert.notEqual(previewDigest(a),previewDigest(b));assert.ok(changedSections(a,b).length);
  }
});
