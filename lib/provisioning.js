import { isIP } from 'node:net';
import { createHash } from 'node:crypto';

export const TYPES = ['realmConfig', 'sipInterface', 'sessionAgent', 'sessionAgentGroup', 'localPolicy'];
export const element = (type, attrs = {}, children = []) => ({ elementTypePath: type, attributes: Object.entries(attrs).map(([name,value]) => ({ name, value: String(value) })), ...(children.length ? { childrenElements: children } : {}) });
export const attr = (e, name) => e.attributes?.find(a => a.name === name)?.value;
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = value => encodeURIComponent(String(value));
export const configRoot = device => `/configuration/deviceConfigs/${id(device)}/configElements`;
export function targetSipAddresses(input,deviceIds) {
  const result=new Map();
  for(const deviceId of deviceIds) {
    const address=String(input.sipAddresses?.[deviceId] ?? (deviceIds.length===1?input.sipAddress:'') ?? '').trim();
    if(!isIP(address))throw new Error(`Provide a valid SIP interface IP address for ${deviceId}`);
    result.set(deviceId,address);
  }
  const canonical=address=>isIP(address)===6?new URL(`http://[${address.split('%')[0]}]/`).hostname:address;
  if(new Set([...result.values()].map(canonical)).size!==result.size)throw new Error('Selected SBCs require different SIP interface IP addresses');
  return result;
}
export function sipWithAddress(object,address) {
  if(!(object.childrenElements || []).some(c=>c.elementTypePath==='sipInterface/sipPort'))throw new Error('A two-target SIP interface edit must include its SIP ports');
  return {...object,childrenElements:object.childrenElements.map(c=>c.elementTypePath==='sipInterface/sipPort'?merge(c,element(c.elementTypePath,{address})):c)};
}
function required(value, label, regex) {
  const s = String(value ?? '').trim();
  if (!s || (regex && !regex.test(s))) throw new Error(`Invalid ${label}`);
  return s;
}
const digits = (value, label) => required(value, label, /^\d+$/);
function network(type, value) {
  const m = required(value, 'network interface', /^[\w-]+:\d+\.[46]$/).match(/^(.+):(\d+)\.([46])$/);
  return element(`${type}/networkInterfaceId`, { name:m[1], subPortId:m[2], family:m[3] });
}
export function generate(input) {
  const mode = required(input.mode, 'service', /^(OC|OL)$/);
  const objects = []; const warnings = [];
  let realm, customer;
  if (mode === 'OC') {
    customer = digits(input.bgid, 'BGID'); realm = `core-oc-bgid${customer}`;
    if(input.scope!=='lrt') {
    const port = digits(input.sipPort, 'SIP interface port');
    if (+port < 1 || +port > 65535) throw new Error('SIP port must be between 1 and 65535');
    if (!isIP(input.sipAddress)) throw new Error('Invalid SIP interface IP address');
    objects.push(element('realmConfig', { id:realm, parent:'core-oc-sbc', mediaPolicy:'markEFandAF31', inManipulationId:'coreOC_in', outManipulationId:'coreOC_out', trustLevel:'high', codecPolicy:'core_codecs_1' }, [network('realmConfig',input.networkInterface || 's1p0:1287.4'), element('realmConfig/InSessionTranslationList',{inSessionTranslationId:'numberFormatToE164'}),element('realmConfig/OutSessionTranslationList',{outSessionTranslationId:'numberFormatOutOL'})]));
    objects.push(element('sipInterface', { RealmID:realm, options:'100rel-interworking,max-udp-length=1300,strip-route-headers,udp-fallback,update-interworking', enforcementProfile:'allowlist-to-ivc', divInfoMappingMode:'hist2div' }, ['TCP','UDP'].map(transProtocol => element('sipInterface/sipPort',{address:input.sipAddress, transProtocol, port, anonMode:'agents-only'}))));
    }
  } else {
    customer = required(input.customerIdentifier, 'customer identifier', /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/);
    const numericId = digits(input.lrtCustomerId, 'numeric customer ID / manipulation string');
    realm = `${customer}-access`;
    if(input.scope!=='lrt') {
    required(input.customerCli, 'customer CLI number', /^\+?\d+$/);
    const agents = input.agentIps;
    if (!Array.isArray(agents) || agents.length < 1 || agents.length > 4 || agents.some(x => !isIP(x))) throw new Error('Provide one to four valid session-agent IP addresses');
    if (new Set(agents).size !== agents.length) throw new Error('Session-agent IP addresses must be unique');
    objects.push(element('realmConfig', { id:realm, parent:'access-ol-sbc', inManipulationId:'accessOL_in', outManipulationId:'accessOL_out', acctEnable:'disabled', netMgmtCtrl:'enabled', hmrString:numericId }, [network('realmConfig',input.networkInterface || 's0p0:1291.4')]));
    for (let i=0; i<agents.length; i++) objects.push(element('sessionAgent', { hostname:`${customer}-${i+1}`, ipAddress:agents[i], realmID:'access-ol-sbc', egressRealmID:'access-ol-sbc', useConstraints:'enabled', maxNumSessions:'2', noResponseTo:'400', inServicePeriod:'30', pingInterval:'30', options:'trans-timeouts=3', inManipulationId:'accessOL_in', outManipulationId:'accessOL_out', hmrString:numericId, 'rfc2833-mode':'transparent', 'rfc2833-payload':'101' }));
    objects.push(element('sessionAgentGroup', { name:`${customer}.corporate.vodafone.ro`, sagRecurse:'enabled', stopRecurse:'400-407,409-499' }, [...agents.map((_,i)=>element('sessionAgentGroup/sipDest',{name:`${customer}-${i+1}`})),element('sessionAgentGroup/trunkGroup',{name:`tg${customer}:${customer}.ims.vf.ro`})]));
    }
    warnings.push('Agent realm and egress realm use access-ol-sbc, matching the supplied configuration. Group membership is replaced with the selected 1–4 agents; unused agent objects are not deleted.');
    warnings.push('Customer CLI is retained in the plan as reference information; the supplied configuration has no distinct CLI attribute. Numeric customer ID populates hmrString and the LRT key prefix.');
  }
  let route = null;
  if (input.includeLrt) {
    const start = digits(input.rangeStart,'range start'), end = digits(input.rangeEnd,'range end');
    if (start.length !== end.length || BigInt(start) > BigInt(end)) throw new Error('Number range endpoints must have equal length and start must not exceed end');
    const area = digits(input.area || '021','area');
    const prefix = mode === 'OC' ? customer : digits(input.lrtCustomerId,'LRT customer ID') + digits(input.numberLength,'number length');
    if (mode === 'OL' && (Number(input.numberLength) !== start.length)) throw new Error('Number length must equal the number of digits in each range endpoint');
    const olPrefix = required(input.numberPrefix || '+40','number prefix', /^\+?\d+$/);
    route = { rangeStart:prefix+start, rangeEnd:prefix+end, sed:mode==='OC' ? `!(^.*$)!sip:\\1;area=${area}@grp-prio-buoc-cscf;egress=${realm}!` : `!(^.*$)!sip:\\1;area=${area};prefix=${olPrefix}@grp-prio-buol-cscf!` };
    required(input.routeSetId,'route set ID', /^[\w-]+$/);
  }
  return { mode, realm, objects, route, warnings, customerCli:input.customerCli || '' };
}

export function selector(e) {
  if (!TYPES.includes(e.elementTypePath)) throw new Error('Unsupported configuration type');
  if (e.elementTypePath === 'localPolicy') {
    const children = (e.childrenElements || []).filter(c => ['localPolicy/from','localPolicy/to','localPolicy/sourceRealm'].includes(c.elementTypePath));
    if (!children.some(c=>c.elementTypePath==='localPolicy/from') || !children.some(c=>c.elementTypePath==='localPolicy/to') || !children.some(c=>c.elementTypePath==='localPolicy/sourceRealm')) throw new Error('Local-policy needs from, to and sourceRealm keys');
    return element('localPolicy',{},children);
  }
  const key = { realmConfig:'id', sipInterface:'RealmID', sessionAgent:'hostname', sessionAgentGroup:'name' }[e.elementTypePath];
  return element(e.elementTypePath,{[key]:required(attr(e,key), `${e.elementTypePath} key`)});
}
export function merge(existing, desired) {
  const attrs = new Map((existing.attributes || []).filter(a=>!['lastModifiedBy','lastModifiedDate','dataVersion'].includes(a.name)).map(a=>[a.name,a.value]));
  for (const a of desired.attributes || []) attrs.set(a.name,String(a.value));
  const replacedTypes = new Set((desired.childrenElements || []).map(c=>c.elementTypePath));
  const children = [...(existing.childrenElements || []).filter(c=>!replacedTypes.has(c.elementTypePath)),...(desired.childrenElements || [])];
  return element(desired.elementTypePath,Object.fromEntries(attrs),children);
}
const bookkeeping=new Set(['lastModifiedBy','lastModifiedDate','dataVersion']);
export function writableConfig(object) {
  return {...element(object.elementTypePath,Object.fromEntries((object.attributes || []).filter(a=>!bookkeeping.has(a.name)).map(a=>[a.name,a.value])),(object.childrenElements || []).map(writableConfig)),...(object.parentElement?{parentElement:writableConfig(object.parentElement)}:{})};
}
function attributeState(object) {
  return (object.attributes || []).filter(a=>!bookkeeping.has(a.name)).map(a=>[a.name,String(a.value)]).sort(([a],[b])=>a.localeCompare(b));
}
function configState(object) {
  return {type:object.elementTypePath,attributes:attributeState(object),children:(object.childrenElements || []).map(configState).sort((a,b)=>fingerprint(a).localeCompare(fingerprint(b)))};
}
// SDM update accepts a single object at each level, not a retrieved object tree.
// Keep the logical object/snapshot intact and compile its individual REST writes.
export async function configUpdateRequests(client,device,before,desired) {
  const requests=[],metadata=new Map(),root=configRoot(device);
  const send=(action,body)=>requests.push({method:'POST',path:`${root}/${action}`,body:writableConfig(body)});
  const scope=(ancestors,leaf)=>ancestors.reduceRight((child,parent)=>({...parent,childrenElements:[child]}),leaf);
  // A delete rooted at the parent deletes that entire parent, even with children.
  // Target the child directly and identify its ancestry with parentElement.
  const childScope=(ancestors,leaf)=>({...leaf,parentElement:ancestors.reduce((parent,key)=>({...key,...(parent?{parentElement:parent}:{})}),undefined)});
  async function keysFor(type) {
    if(!metadata.has(type)) {
      const m=await client.request('POST',`/configuration/deviceConfigs/${id(device)}/elementTypes/elementMetadata`,{elementTypePath:type});
      if(!Array.isArray(m?.attributeMetadatas))throw new Error(`Cannot determine SDM child keys for ${type}; no update was prepared`);
      metadata.set(type,m.attributeMetadatas.filter(a=>a.key===true || a.key==='true').map(a=>a.name));
    }
    return metadata.get(type);
  }
  async function visit(old,next,ancestors,key) {
    if(fingerprint(attributeState(old))!==fingerprint(attributeState(next)))send('update',scope(ancestors,{...key,attributes:writableConfig(next).attributes}));
    const oldChildren=old.childrenElements || [],newChildren=next.childrenElements || [];
    for(const type of new Set([...oldChildren,...newChildren].map(c=>c.elementTypePath))) {
      const a=oldChildren.filter(c=>c.elementTypePath===type),b=newChildren.filter(c=>c.elementTypePath===type);
      const states=rows=>rows.map(configState).sort((x,y)=>fingerprint(x).localeCompare(fingerprint(y)));
      if(fingerprint(states(a))===fingerprint(states(b)))continue;
      const keys=await keysFor(type);
      if(!keys.length && (a.length>1 || b.length>1))throw new Error(`Cannot identify individual ${type} children; no update was prepared`);
      const childKey=c=>element(type,Object.fromEntries(keys.map(k=>{const value=attr(c,k);if(value===undefined)throw new Error(`Missing ${type} key ${k}`);return [k,value];})));
      const indexed=rows=>{const map=new Map();for(const c of rows){const k=fingerprint(attributeState(childKey(c)));if(map.has(k))throw new Error(`Duplicate ${type} child key`);map.set(k,c);}return map;};
      const oldByKey=indexed(a),newByKey=indexed(b),parents=[...ancestors,key];
      for(const [k,c] of oldByKey)if(!newByKey.has(k))send('delete',childScope(parents,childKey(c)));
      for(const [k,c] of newByKey) {
        const previous=oldByKey.get(k);
        if(!previous)send('add',childScope(parents,writableConfig(c)));
        else await visit(previous,merge(previous,c),parents,childKey(previous));
      }
    }
  }
  await visit(before,desired,[],selector(before));
  return requests;
}
export function matches(element, query) { return JSON.stringify(element).toLowerCase().includes(query.toLowerCase()); }
export function routeMatches(row, query, mode, numericId='') {
  const q = mode==='OL' ? (numericId || query) : query;
  return String(row.rangeStart || '').startsWith(q) || String(row.rangeEnd || '').startsWith(q) || String(row.sed || '').toLowerCase().includes(query.toLowerCase());
}
export function checkResult(result) {
  if (!result || String(result.status || '').toUpperCase()!=='SUCCESS' || Object.entries(result).some(([key,value])=>key.startsWith('is') && /FAIL|ERROR/i.test(String(value)))) throw Object.assign(new Error('SDM did not confirm a successful configuration action; inspect the REST activity response.'),{details:{response:result}});
}
export async function cleanConfig(client, device) {
  const summary = await client.request('GET', `/configuration/devices/${id(device)}`);
  if (Number(summary?.pendingChanges || 0) > 0) throw new Error(`Device ${device} has pending changes in SDM. Resolve them before provisioning.`);
  const loaded = await client.request('GET', `/configuration/devices/${id(device)}/loadConfig`);
  if (loaded?.pendingChanges===undefined || !Number.isFinite(Number(loaded.pendingChanges)))throw new Error(`Cannot verify a clean SDM staging area for ${device}; no changes were prepared`);
  if (Number(loaded.pendingChanges) !== 0) throw new Error(`Device ${device} has pending changes in SDM.`);
}
export async function resolveObjects(client, device, objects, action='create') {
  if(!['create','update','auto'].includes(action)) throw new Error('Invalid configuration action');
  const ops = []; const lists = new Map();
  for (const e of objects) {
    const type = e.elementTypePath; const key = selector(e);
    if (!lists.has(type)) lists.set(type,await client.list(`${configRoot(device)}?elementTypePath=${type}`, 'configElements'));
    const found = lists.get(type).find(row => fingerprint(selector(row))===fingerprint(key));
    if(action==='create' && found) throw new Error(`${type} already exists. Choose Update existing or Create missing / update existing to change it.`);
    if(action==='update' && !found) throw new Error(`${type} does not exist. Choose Create new to add it.`);
    const old = found ? await client.request('POST', `${configRoot(device)}/retrieve`, key) : null;
    if(found && (!old || old.elementTypePath!==type)) throw new Error(`Could not retrieve existing ${type}; no update was prepared`);
    const body=old?merge(old,e):e;
    ops.push({ method:'POST', path:`${configRoot(device)}/${old?'update':'add'}`, body, before:old,...(old?{requests:await configUpdateRequests(client,device,old,body)}:{}) });
  }
  return ops;
}
export async function resolveRoute(client, routeSetId, route, entryId='') {
  if (entryId && !/^[\w-]+$/.test(entryId)) throw new Error('Invalid LRT entry ID');
  const rows = await client.list(`/routeSets/${id(routeSetId)}/entries/`,'routeSetEntries');
  const old = entryId ? rows.find(r=>r.objectId===entryId) : rows.find(r=>r.rangeStart===route.rangeStart && r.rangeEnd===route.rangeEnd);
  if (entryId && !old) throw new Error('Selected LRT entry no longer exists');
  const overlap = rows.find(r=>r.objectId!==old?.objectId && /^\d+$/.test(r.rangeStart) && /^\d+$/.test(r.rangeEnd) && BigInt(r.rangeStart)<=BigInt(route.rangeEnd) && BigInt(r.rangeEnd)>=BigInt(route.rangeStart));
  if (overlap) throw new Error(`LRT range overlaps existing entry ${overlap.objectId}`);
  const body = old ? {...old,...route} : route;
  delete body.objectId;
  return { method:old?'PUT':'POST', path:`/routeSets/${id(routeSetId)}/entries/${old?id(old.objectId):''}`, body, before:old || null };
}
export async function locked(client, route, fn) {
  await client.request('POST',route,{type:'Lock'});
  let error;
  try { return await fn(); } catch(e) { error=e; throw e; }
  finally { try { await client.request('POST',route,{type:'Unlock'}); } catch(e) { if (!error) throw e; error.message += `; unlock also failed: ${e.message}`; } }
}
export async function applyConfig(client, device, ops) {
  let staged = 0;
  try {
    for (const op of ops) for(const request of op.requests || [op]) { await client.request(request.method,request.path,request.body); staged++; }
    checkResult(await client.request('POST',`/configuration/devices/${id(device)}/action`,{type:'SaveActivateConfig'}));
  } catch(e) { e.message += `; ${staged} object(s) staged. Configuration changes may remain in SDM; inspect pending changes before retrying.`; throw e; }
}
export async function deployRoutes(client, routeSetId, groupIds, { sleep = ms => new Promise(r=>setTimeout(r,ms)), timeoutMs = 180000 } = {}) {
  const groupObjects=groupIds.map(deviceGroupId=>({deviceGroupId}));
  const update = await client.request('POST',`/routeSets/${id(routeSetId)}/devices/action`,{ deviceGroups:{deviceGroup:groupObjects.length===1?groupObjects[0]:groupObjects},action:'Update',failureAction:'rollback' });
  if (!update?.objectId) throw new Error('SDM did not return a route update ID; inspect route update history before retrying');
  const path = `/routeSets/routeUpdates/${id(update.objectId)}`; const deadline = Date.now()+timeoutMs;
  try {
    while (Date.now()<deadline) {
      const result = await client.request('GET',path);
      const statuses = [result.updateStatus,...(result.deviceStatusList || []).flatMap(d=>[d.status,d.pushStatus])].filter(Boolean);
      if (statuses.some(s=>/fail|error|cancel|rollback/i.test(s))) throw new Error(`Route deployment failed (${statuses.join(', ')})`);
      if (result.updateStatus==='Completed' && (result.deviceStatusList || []).every(d=>d.status==='Completed' && d.pushStatus==='Completed')) {
        await client.request('POST',`${path}/action`,{type:'Commit'}); return {updateId:update.objectId};
      }
      await sleep(2000);
    }
    throw new Error('Route deployment timed out');
  } catch(e) {
    try { await client.request('POST',`${path}/action`,{type:'Rollback'}); } catch(rollback) { e.message+=`; rollback request failed: ${rollback.message}`; }
    e.message+=`; route update ID ${update.objectId}. Inspect SDM status; rollback completion is not assumed.`; throw e;
  }
}
