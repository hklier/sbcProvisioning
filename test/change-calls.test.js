import test from 'node:test';
import assert from 'node:assert/strict';
import {isChangeCall} from '../lib/change-calls.js';
test('success export includes change and deployment calls, omitting reads, authentication, locks and recovery',()=>{
  const check=(method,path,request)=>isChangeCall({method,url:'https://sdm/rest/v1.3'+path,request});
  for(const action of ['add','update','delete'])assert.ok(check('POST',`/configuration/deviceConfigs/ID8/configElements/${action}`,{}));
  for(const method of ['POST','PUT','DELETE'])assert.ok(check(method,'/routeSets/13/entries/ID1',{}));
  assert.ok(check('POST','/routeSets/13/entries/',{}));
  assert.ok(check('POST','/configuration/devices/ID8/action',{type:'SaveActivateConfig'}));
  assert.ok(check('POST','/routeSets/13/devices/',{assocDevices:[{deviceGroupId:'ID14'}]}));
  assert.ok(check('POST','/routeSets/13/devices/action',{action:'Update'}));
  assert.ok(check('POST','/routeSets/routeUpdates/1/action',{type:'Commit'}));
  for(const [method,path,request] of [
    ['POST','/admin/login',{}],['POST','/admin/logout',{}],['GET','/configuration/devices/ID8/loadConfig'],
    ['POST','/configuration/deviceConfigs/ID8/configElements/retrieve',{}],['GET','/routeSets/13/entries/'],
    ['POST','/inventory/deviceMgmt/devices/ID8/action',{type:'Lock'}],['POST','/routeSets/13/action',{type:'Unlock'}],
    ['GET','/routeSets/routeUpdates/1'],['POST','/routeSets/routeUpdates/1/action',{type:'Rollback'}],
    ['DELETE','/configuration/deviceConfigs/ID8/configurationChanges']
  ])assert.equal(check(method,path,request),false,`${method} ${path}`);
  assert.equal(isChangeCall({method:'POST',url:'not a URL'}),false);
});
