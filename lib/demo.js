import { generate, element, selector, fingerprint, merge } from './provisioning.js';

export class DemoClient {
  constructor(onLog) {
    this.onLog=onLog; this.baseUrl='demo://sdm/rest/v1.3';
    this.devices=[{id:'ID8',name:'vmESBC',ip:'192.168.3.51',nfId:'ID14',nfName:'vmESBC01',connectivityStatus:true},{id:'ID6',name:'vmESBC3Prim',ip:'192.168.3.251',nfId:'ID12',nfName:'vmESBC02Cluster',connectivityStatus:true}];
    this.routeSets=[{routeSetId:'2',name:'lookupAccessOc',lockState:'false',version:'0'},{routeSetId:'3',name:'lookupAccessOl',lockState:'false',version:'0'}];
    const oc=generate({mode:'OC',bgid:'1227100253',sipPort:'6000',sipAddress:'10.229.189.129'});
    const ol=generate({mode:'OL',customerIdentifier:'N529704BUCPE4',customerCli:'372818574',lrtCustomerId:'152970402130004',agentIps:['172.22.250.226']});
    this.configs=new Map(this.devices.map(d=>[d.id,structuredClone([...oc.objects,...ol.objects,element('localPolicy',{},[element('localPolicy/from',{addr:'*'}),element('localPolicy/to',{addr:'*'}),element('localPolicy/sourceRealm',{name:'access'})])])]));
    this.entries=new Map([['2',[{objectId:'ID1',rangeStart:'1227100253371542577',rangeEnd:'1227100253371542577',sed:'!(^.*$)!sip:\\1;area=021@grp-prio-buoc-cscf;egress=core-oc-bgid1227100253!'}]],['3',[{objectId:'ID2',rangeStart:'1529704021300049372818574',rangeEnd:'1529704021300049372818576',sed:'!(^.*$)!sip:\\1;area=021;prefix=+40@grp-prio-buol-cscf!'}]]]);
    this.locks=new Set();
    this.runningConfigs=structuredClone(this.configs);this.routeTasks=new Map();this.nextTask=1;
    this.deployedRoutes=new Map(this.devices.map(d=>[d.nfId,new Map([...this.entries].map(([s,r])=>[s,structuredClone(r)]))]));
    this.associations=new Map(['2','3'].map(set=>[set,[{deviceGroupId:this.devices[0].nfId,version:'0'}]]));
  }
  async login() { return this.request('POST','/admin/login',{userName:'demo',password:'[redacted]'}); }
  async list(path,key) { return (await this.request('GET',path))[key]; }
  async request(method,path,body) {
    let response=null, status=200;
    const url=new URL('http://demo'+path); const p=url.pathname;
    if((this.failure==='activate-second' && p===`/configuration/devices/${this.failureDevice}/action` && body?.type==='SaveActivateConfig') || (this.failure==='lrt-push' && /\/routeSets\/[^/]+\/devices\/action$/.test(p))) {
      this.failure='';const error=new Error('Simulated REST failure for rollback testing');error.details={method,url:this.baseUrl+path,status:500,response:{message:error.message}};this.onLog({...error.details,request:body,time:new Date().toISOString(),durationMs:1,demo:true});throw error;
    }
    if(p==='/admin/login') response={userName:'demo',sessionId:'[redacted]'};
    else if(p==='/admin/logout') status=204;
    else if(p==='/inventory/deviceMgmt/devices/') response={devices:this.devices};
    else if(p==='/routeSets/') response={routeSets:this.routeSets};
    else if(/^\/routeSets\/[^/]+\/devices\/?$/.test(p)) {
      const set=p.split('/')[2];
      if(method==='DELETE'){this.associations.set(set,(this.associations.get(set)||[]).filter(g=>g.deviceGroupId!==p.split('/')[4]));status=204;}
      else if(method==='GET')response={assocDevices:structuredClone(this.associations.get(set) || [])};
      else {this.associations.set(set,[...(this.associations.get(set) || []),...body.assocDevices]);response=null;}
    }
    else if(/^\/routeSets\/[^/]+\/devices\/[^/]+$/.test(p) && method==='DELETE') {const set=p.split('/')[2];this.associations.set(set,(this.associations.get(set)||[]).filter(g=>g.deviceGroupId!==p.split('/')[4]));status=204;}
    else if(/\/routeUpdates\/[^/]+\/action$/.test(p)) {const task=this.routeTasks.get(p.split('/')[3]);if(body.type==='Rollback'){for(const [g,before] of task.before)this.deployedRoutes.get(g).set(task.set,structuredClone(before));task.rolledBack=true;}status=204;}
    else if(/\/routeUpdates\//.test(p)) {const task=this.routeTasks.get(p.split('/')[3]);response={updateStatus:'Completed',rollbackStatus:task.rolledBack?'Completed':'Unknown',deviceStatusList:task.groups.map(deviceGroupId=>({deviceGroupId,status:'Completed',pushStatus:'Completed',rollBackStatus:task.rolledBack?'Completed':'Unknown'}))};}
    else if(/\/routeSets\/[^/]+\/devices\/action$/.test(p)) {const set=p.split('/')[2];const groups=[body.deviceGroups.deviceGroup].flat().map(g=>g.deviceGroupId);const task={set,groups,before:groups.map(g=>[g,structuredClone(this.deployedRoutes.get(g).get(set)||[])])};const taskId=`DEMO-UPDATE-${this.nextTask++}`;this.routeTasks.set(taskId,task);for(const g of groups)this.deployedRoutes.get(g).set(set,structuredClone(this.entries.get(set)||[]));response={objectId:taskId};}
    else if(p.endsWith('/action') && ['Lock','Unlock'].includes(body?.type)) {
      if(body.type==='Lock' && this.locks.has(p)) throw new Error('Resource is locked');
      body.type==='Lock'?this.locks.add(p):this.locks.delete(p); status=204;
    }
    else if(p.endsWith('/action')) {const device=p.split('/')[3];this.runningConfigs.set(device,structuredClone(this.configs.get(device)));response={status:'SUCCESS',isActivateConfigSuccess:'SUCCESS'};}
    else if(/^\/configuration\/devices\//.test(p)) response={pendingChanges:fingerprint(this.configs.get(p.split('/')[3]))===fingerprint(this.runningConfigs.get(p.split('/')[3]))?'0':'1',status:'success'};
    else if(p.endsWith('/configurationChanges') && method==='DELETE'){const device=p.split('/')[3];this.configs.set(device,structuredClone(this.runningConfigs.get(device)));status=204;}
    else if(p.includes('/configElements')) {
      const device=p.split('/')[3], rows=this.configs.get(device) || [];
      if(method==='GET') response={configElements:rows.filter(e=>e.elementTypePath===url.searchParams.get('elementTypePath'))};
      else { const index=rows.findIndex(e=>fingerprint(selector(e))===fingerprint(selector(body)));
        if(p.endsWith('/retrieve')) { if(index<0) throw new Error('Demo object not found'); response=structuredClone(rows[index]); }
        else if(p.endsWith('/delete')){if(index<0)throw new Error('Demo object not found');rows.splice(index,1);status=204;}
        else { if(index>=0) rows[index]=merge(rows[index],body); else rows.push(structuredClone(body)); response=body; }
      }
    } else if(p.includes('/entries')) {
      const set=p.split('/')[2], rows=this.entries.get(set) || []; const entry=p.split('/')[4];
      if(method==='GET') response={routeSetEntries:structuredClone(rows)};
      else if(method==='DELETE'){const index=rows.findIndex(r=>r.objectId===entry);if(index<0)throw new Error('Demo entry not found');rows.splice(index,1);status=204;}
      else if(method==='PUT') { const index=rows.findIndex(r=>r.objectId===entry); if(index<0) throw new Error('Demo entry not found'); rows[index]={...body,objectId:entry}; response=rows[index]; }
      else { const row={...body,objectId:`DEMO-${this.nextTask++}`}; rows.push(row); this.entries.set(set,rows); response=row; }
    } else throw new Error('Unsupported demo request');
    this.onLog({method,url:this.baseUrl+path,request:body,status,response:structuredClone(response),durationMs:1,time:new Date().toISOString(),demo:true});
    return response;
  }
}
