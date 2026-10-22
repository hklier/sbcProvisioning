import { generate, element, selector, fingerprint, merge } from './provisioning.js';

export class DemoClient {
  constructor(onLog) {
    this.onLog=onLog; this.baseUrl='demo://sdm/rest/v1.3';
    this.devices=[{id:'ID8',name:'vmESBC',ip:'192.168.3.51',nfId:'ID14',nfName:'vmESBC01',connectivityStatus:true},{id:'ID6',name:'vmESBC3Prim',ip:'192.168.3.251',nfId:'ID12',nfName:'vmESBC02Cluster',connectivityStatus:true}];
    this.routeSets=[{routeSetId:'2',name:'lookupAccessOc',lockState:'false'},{routeSetId:'3',name:'lookupAccessOl',lockState:'false'}];
    const oc=generate({mode:'OC',bgid:'1227100253',sipPort:'6000',sipAddress:'10.229.189.129'});
    const ol=generate({mode:'OL',customerIdentifier:'N529704BUCPE4',customerCli:'372818574',lrtCustomerId:'152970402130004',agentIps:['172.22.250.226']});
    this.configs=new Map(this.devices.map(d=>[d.id,structuredClone([...oc.objects,...ol.objects,element('localPolicy',{},[element('localPolicy/from',{addr:'*'}),element('localPolicy/to',{addr:'*'}),element('localPolicy/sourceRealm',{name:'access'})])])]));
    this.entries=new Map([['2',[{objectId:'ID1',rangeStart:'1227100253371542577',rangeEnd:'1227100253371542577',sed:'!(^.*$)!sip:\\1;area=021@grp-prio-buoc-cscf;egress=core-oc-bgid1227100253!'}]],['3',[{objectId:'ID2',rangeStart:'1529704021300049372818574',rangeEnd:'1529704021300049372818576',sed:'!(^.*$)!sip:\\1;area=021;prefix=+40@grp-prio-buol-cscf!'}]]]);
    this.locks=new Set();
    this.associations=new Map(['2','3'].map(set=>[set,[{deviceGroupId:this.devices[0].nfId}]]));
  }
  async login() { return this.request('POST','/admin/login',{userName:'demo',password:'[redacted]'}); }
  async list(path,key) { return (await this.request('GET',path))[key]; }
  async request(method,path,body) {
    let response=null, status=200;
    const url=new URL('http://demo'+path); const p=url.pathname;
    if(p==='/admin/login') response={userName:'demo',sessionId:'[redacted]'};
    else if(p==='/admin/logout') status=204;
    else if(p==='/inventory/deviceMgmt/devices/') response={devices:this.devices};
    else if(p==='/routeSets/') response={routeSets:this.routeSets};
    else if(/^\/routeSets\/[^/]+\/devices\/?$/.test(p)) {
      const set=p.split('/')[2];
      if(method==='GET')response={assocDevices:structuredClone(this.associations.get(set) || [])};
      else {this.associations.set(set,[...(this.associations.get(set) || []),...body.assocDevices]);response=null;}
    }
    else if(/\/routeUpdates\/[^/]+\/action$/.test(p)) status=204;
    else if(/\/routeUpdates\//.test(p)) response={updateStatus:'Completed',deviceStatusList:[{status:'Completed',pushStatus:'Completed'}]};
    else if(/\/routeSets\/[^/]+\/devices\/action$/.test(p)) response={objectId:'DEMO-UPDATE'};
    else if(p.endsWith('/action') && ['Lock','Unlock'].includes(body?.type)) {
      if(body.type==='Lock' && this.locks.has(p)) throw new Error('Resource is locked');
      body.type==='Lock'?this.locks.add(p):this.locks.delete(p); status=204;
    }
    else if(p.endsWith('/action')) response={status:'SUCCESS',isActivateConfigSuccess:'SUCCESS'};
    else if(/^\/configuration\/devices\//.test(p)) response={pendingChanges:'0',status:'success'};
    else if(p.includes('/configElements')) {
      const device=p.split('/')[3], rows=this.configs.get(device) || [];
      if(method==='GET') response={configElements:rows.filter(e=>e.elementTypePath===url.searchParams.get('elementTypePath'))};
      else { const index=rows.findIndex(e=>fingerprint(selector(e))===fingerprint(selector(body)));
        if(p.endsWith('/retrieve')) { if(index<0) throw new Error('Demo object not found'); response=structuredClone(rows[index]); }
        else { if(index>=0) rows[index]=merge(rows[index],body); else rows.push(structuredClone(body)); response=body; }
      }
    } else if(p.includes('/entries')) {
      const set=p.split('/')[2], rows=this.entries.get(set) || []; const entry=p.split('/')[4];
      if(method==='GET') response={routeSetEntries:structuredClone(rows)};
      else if(method==='PUT') { const index=rows.findIndex(r=>r.objectId===entry); if(index<0) throw new Error('Demo entry not found'); rows[index]={...body,objectId:entry}; response=rows[index]; }
      else { const row={...body,objectId:`DEMO-${rows.length+1}`}; rows.push(row); this.entries.set(set,rows); response=row; }
    } else throw new Error('Unsupported demo request');
    this.onLog({method,url:this.baseUrl+path,request:body,status,response:structuredClone(response),durationMs:1,time:new Date().toISOString(),demo:true});
    return response;
  }
}
