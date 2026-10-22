import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { SdmClient, readCredentials, redact } from './lib/sdm.js';
import { DemoClient } from './lib/demo.js';
import { TYPES, generate, selector, matches, routeMatches, configRoot, cleanConfig, resolveObjects, resolveRoute, locked, applyConfig, deployRoutes, fingerprint } from './lib/provisioning.js';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const BASE=process.env.SDM_BASE_URL || 'https://192.168.3.153:8443/rest/v1.3';
const CREDENTIALS=process.env.SDM_CREDENTIALS_FILE || path.resolve(ROOT,'../vf-ro-provisioning/sdm-rest-api-cred.txt');
const sessions=new Map(); let liveWriter=false; let shuttingDown=false;
const token=()=>randomBytes(24).toString('hex');
function send(res,status,body,type='application/json; charset=utf-8') { res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",'Referrer-Policy':'no-referrer'}); res.end(type.startsWith('application/json')?JSON.stringify(body):body); }
async function body(req) { let text=''; for await(const chunk of req) { text+=chunk; if(text.length>1024*1024) throw new Error('Request exceeds 1 MB'); } return JSON.parse(text || '{}'); }
function auth(req) {
  if(!process.env.APP_PASSWORD) return true;
  const expected=Buffer.from('Basic '+Buffer.from(`${process.env.APP_USERNAME || 'admin'}:${process.env.APP_PASSWORD}`).toString('base64'));
  const actual=Buffer.from(req.headers.authorization || ''); return expected.length===actual.length && timingSafeEqual(expected,actual);
}
function getSession(req,res) {
  const cookie=(req.headers.cookie || '').match(/(?:^|;\s*)provisionSession=([a-f0-9]+)/)?.[1];
  let session=sessions.get(cookie);
  if(!session) {
    const sid=token(); session={csrf:token(),plans:new Map(),jobs:new Map(),lastSeen:Date.now(),mode:'demo'}; sessions.set(sid,session);
    res.setHeader('Set-Cookie',`provisionSession=${sid}; HttpOnly; SameSite=Strict; Path=/${process.env.COOKIE_SECURE==='true'?'; Secure':''}`);
    session.client=new DemoClient(()=>{});
  }
  session.lastSeen=Date.now(); return session;
}
function createJob(session,fn) {
  if([...session.jobs.values()].some(j=>j.status==='running')) throw new Error('Wait for the current operation to finish');
  const job={id:token(),status:'running',logs:[],started:new Date().toISOString()}; session.jobs.set(job.id,job);
  if(session.jobs.size>20) session.jobs.delete(session.jobs.keys().next().value);
  const client=session.client; client.onLog=entry=>{ if(job.logs.length>=3000) { job.logs.shift(); job.truncated=true; } job.logs.push(redact(entry)); };
  Promise.resolve().then(()=>fn(client)).then(result=>{job.result=result;job.status='complete';}).catch(error=>{job.error=redact(error.message,[client.credentials?.password,client.cookie,client.cookie?.split('=')[1]]);job.status='failed';}).finally(()=>{client.onLog=()=>{};});
  return {jobId:job.id};
}
async function inventory(session,client) {
  session.devices=await client.list('/inventory/deviceMgmt/devices/','devices');
  session.routeSets=await client.list('/routeSets/','routeSets');
  return {devices:session.devices,routeSets:session.routeSets,mode:session.mode};
}
function targets(session,input) {
  if(!Array.isArray(input.deviceIds) || !input.deviceIds.length) throw new Error('Select at least one SBC');
  const devices=input.deviceIds.map(deviceId=>session.devices?.find(d=>d.id===deviceId));
  if(devices.some(d=>!d)) throw new Error('Unknown target device; refresh inventory');
  if(new Set(devices.map(d=>d.nfId || d.id)).size!==devices.length) throw new Error('Select one SBC per HA/device group to avoid applying the same group twice');
  return devices;
}
async function routeOperation(session,client,input,route) {
  if(!route) return null;
  const set=session.routeSets?.find(r=>String(r.routeSetId)===String(input.routeSetId));
  if(!set) throw new Error('Select a known route set');
  if(String(set.lockState)==='true' && set.lockOwner && set.lockOwner!==client.credentials?.userName) throw new Error(`Route set is locked by ${set.lockOwner}`);
  return resolveRoute(client,input.routeSetId,route,input.entryId || '');
}
async function prepare(session,client,input) {
  const devices=targets(session,input);
  let generated;
  if(input.kind==='routeEdit') {
    const r=input.route;
    if(!r || !/^\d+$/.test(r.rangeStart) || !/^\d+$/.test(r.rangeEnd) || r.rangeStart.length!==r.rangeEnd.length || BigInt(r.rangeStart)>BigInt(r.rangeEnd) || typeof r.sed!=='string' || !r.sed.trim()) throw new Error('LRT edit requires valid equal-length numeric endpoints and a nonempty sed expression');
    if(!input.entryId) throw new Error('Select an existing LRT entry to edit');
    generated={objects:[],route:{...r},warnings:['Manual LRT update. Keys and routing expression are used exactly as entered.']}; delete generated.route.objectId;
  } else generated=input.kind==='edit' ? {objects:[input.object],route:null,warnings:['Manual object update. Review all attributes before applying.']} : generate(input);
  if(input.kind==='edit') { selector(input.object); if(!Array.isArray(input.object.attributes)) throw new Error('Invalid configuration element'); }
  const configurations=[];
  if(input.scope!=='lrt') for(const device of devices) {
    await cleanConfig(client,device.id);
    configurations.push({deviceId:device.id,operations:await resolveObjects(client,device.id,generated.objects)});
  }
  const route=await routeOperation(session,client,input,generated.route);
  if(input.scope==='lrt' && !route) throw new Error('Enable LRT to prepare an LRT-only change');
  if(route && devices.some(d=>!d.nfId)) throw new Error('Selected SBC has no device group for LRT deployment');
  const groupIds=[...new Set(devices.map(d=>d.nfId).filter(Boolean))];
  const associations=[];
  if(route) {
    let existing;
    try {existing=await client.request('GET',`/routeSets/${encodeURIComponent(input.routeSetId)}/devices/`);}
    catch(e) {if(e.status!==404)throw e;existing={assocDevices:[]};}
    if(!Array.isArray(existing?.assocDevices))throw new Error('Unexpected SDM route set association response');
    const missing=groupIds.filter(group=>!existing.assocDevices.some(a=>a.deviceGroupId===group));
    if(missing.length && !input.associateTarget)throw new Error(`Route set is not associated with device group(s) ${missing.join(', ')}. Enable “Associate selected SBC if missing” or select an associated route set.`);
    if(missing.length) {
      associations.push({method:'POST',path:`/routeSets/${encodeURIComponent(input.routeSetId)}/devices/`,body:{assocDevices:missing.map(deviceGroupId=>({deviceGroupId}))}});
      generated.warnings.push('The preview includes a new route set association for the selected SBC group. Association changes persist if a later step fails.');
    }
  }
  return {configurations,route,associations,deviceIds:devices.map(d=>d.id),groupIds,routeSetId:input.routeSetId || '',warnings:generated.warnings,realm:generated.realm,customerCli:generated.customerCli};
}
function digest(plan) { return fingerprint({configurations:plan.configurations,route:plan.route,associations:plan.associations,deviceIds:plan.deviceIds,groupIds:plan.groupIds,routeSetId:plan.routeSetId}); }
async function apply(session,client,plan) {
  if(plan.used || Date.now()>plan.expires) throw new Error('Preview expired or already used; generate a new preview');
  if(session.mode==='live' && liveWriter) throw new Error('Another live provisioning operation is running');
  if(session.mode==='live') liveWriter=true;
  plan.used=true;
  const completed=[];
  const resources=[...plan.configurations.map(c=>`/inventory/deviceMgmt/devices/${encodeURIComponent(c.deviceId)}/action`),...(plan.route?[`/routeSets/${encodeURIComponent(plan.routeSetId)}/action`]:[])];
  const withLocks=async index=> index===resources.length ? perform() : locked(client,resources[index],()=>withLocks(index+1));
  async function perform() {
    await inventory(session,client);
    const fresh=await prepare(session,client,plan.input);
    if(digest(fresh)!==plan.digest) throw new Error('SDM state changed since preview. Generate a new preview before applying.');
    for(const op of plan.associations) {await client.request(op.method,op.path,op.body);completed.push('Selected device group associated with the route set');}
    for(const config of plan.configurations) { await applyConfig(client,config.deviceId,config.operations); completed.push(`Configuration activated on ${config.deviceId}`); }
    if(plan.route) {
      await client.request(plan.route.method,plan.route.path,plan.route.body);
      completed.push('LRT entry stored in SDM');
      const result=await deployRoutes(client,plan.routeSetId,plan.groupIds);
      completed.push(`LRT deployed and committed (${result.updateId})`);
    }
    return {completed};
  }
  try {return await withLocks(0);} catch(e) {e.message+=completed.length?`; completed steps: ${completed.join('; ')}. Configuration and LRT are separate transactions.`:'';throw e;}
  finally { if(session.mode==='live') liveWriter=false; }
}

const tlsEnabled=Boolean(process.env.TLS_KEY_FILE && process.env.TLS_CERT_FILE);
if(Boolean(process.env.TLS_KEY_FILE)!==Boolean(process.env.TLS_CERT_FILE)) throw new Error('Set both TLS_KEY_FILE and TLS_CERT_FILE to enable HTTPS');
const createServer=tlsEnabled ? handler=>https.createServer({key:fs.readFileSync(process.env.TLS_KEY_FILE),cert:fs.readFileSync(process.env.TLS_CERT_FILE)},handler) : handler=>http.createServer(handler);
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/healthz') return send(res,shuttingDown?503:200,{status:shuttingDown?'draining':'ok'});
    if(shuttingDown && req.method!=='GET') return send(res,503,{error:'Server is stopping; no new operations are accepted'});
    if(!auth(req)) {res.setHeader('WWW-Authenticate','Basic realm="SBC Provisioning"');return send(res,401,{error:'Sign in required'});}
    if(!url.pathname.startsWith('/api/')) {
      const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css'}; const file=files[url.pathname];
      if(!file || req.method!=='GET') return send(res,404,{error:'Not found'});
      return send(res,200,fs.readFileSync(path.join(ROOT,'public',file)),file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html');
    }
    const session=getSession(req,res);
    if(req.method!=='GET' && (req.headers['x-csrf-token']!==session.csrf || (req.headers.origin && new URL(req.headers.origin).host!==req.headers.host))) return send(res,403,{error:'Invalid request token or origin'});
    if(req.method==='GET' && url.pathname==='/api/status') return send(res,200,{mode:session.mode,csrf:session.csrf,baseUrl:BASE,credentialsAvailable:fs.existsSync(CREDENTIALS) || !!(process.env.SDM_USERNAME && process.env.SDM_PASSWORD),verifyTls:session.mode==='live'?session.client.verifyTls:true});
    const jobMatch=url.pathname.match(/^\/api\/jobs\/([a-f0-9]+)$/);
    if(req.method==='GET' && jobMatch) { const job=session.jobs.get(jobMatch[1]);return send(res,job?200:404,job || {error:'Job not found'}); }
    if(req.method!=='POST') return send(res,404,{error:'Not found'});
    const input=await body(req);
    if(url.pathname==='/api/connect') {
      if([...session.jobs.values()].some(j=>j.status==='running')) throw new Error('Wait for the current operation');
      if(input.mode!=='demo' && input.mode!=='live') throw new Error('Invalid connection mode');
      const old=session.client;
      if(session.mode==='live' && old.cookie) await old.request('POST','/admin/logout',old.credentials).catch(()=>{});
      session.mode=input.mode; session.plans.clear(); session.devices=[]; session.routeSets=[];
      session.client=input.mode==='demo'?new DemoClient(()=>{}):new SdmClient({baseUrl:BASE,credentials:process.env.SDM_USERNAME && process.env.SDM_PASSWORD ? {userName:process.env.SDM_USERNAME,password:process.env.SDM_PASSWORD}:readCredentials(CREDENTIALS),verifyTls:input.labTls!==true,ca:process.env.SDM_CA_FILE?fs.readFileSync(process.env.SDM_CA_FILE):undefined});
      return send(res,202,createJob(session,async client=>{await client.login();return inventory(session,client);}));
    }
    if(url.pathname==='/api/inventory') return send(res,202,createJob(session,c=>inventory(session,c)));
    if(url.pathname==='/api/search') return send(res,202,createJob(session,async client=>{
      const device=targets(session,{deviceIds:[input.deviceId]})[0];
      const query=String(input.filter || '').trim(); if(!query) throw new Error('Enter a BGID or customer identifier');
      const types=input.type==='all'?TYPES:[input.type]; if(types.some(t=>!TYPES.includes(t))) throw new Error('Unsupported object type');
      await cleanConfig(client,device.id);
      const rows=[];
      for(const type of types) {
        const elements=await client.list(`${configRoot(device.id)}?elementTypePath=${type}`,'configElements');
        for(const e of elements) {
          const keyMatch=matches(e,query);
          if(!keyMatch && !(input.mode==='OL' && /^\d+$/.test(query) && ['realmConfig','sessionAgent'].includes(type))) continue;
          const full=await client.request('POST',`${configRoot(device.id)}/retrieve`,selector(e));
          if(keyMatch || matches(full,query)) rows.push(full);
        }
      }
      let routes=[];
      if(input.routeSetId) {
        if(!session.routeSets?.some(r=>String(r.routeSetId)===String(input.routeSetId))) throw new Error('Unknown route set');
        const hmrStrings=[...new Set(rows.flatMap(e=>(e.attributes || []).filter(a=>a.name==='hmrString' && /^\d+$/.test(a.value)).map(a=>a.value)))];
        const prefixes=input.numericId?[input.numericId]:hmrStrings.length?hmrStrings:[''];
        routes=(await client.list(`/routeSets/${encodeURIComponent(input.routeSetId)}/entries/`,'routeSetEntries')).filter(r=>prefixes.some(prefix=>routeMatches(r,query,input.mode,prefix)));
      }
      return {objects:rows,routes,filter:query};
    }));
    if(url.pathname==='/api/retrieve') return send(res,202,createJob(session,async client=>{
      targets(session,{deviceIds:[input.deviceId]});
      await cleanConfig(client,input.deviceId);
      return client.request('POST',`${configRoot(input.deviceId)}/retrieve`,selector(input.object));
    }));
    if(url.pathname==='/api/preview') return send(res,202,createJob(session,async client=>{
      if(!session.devices?.length) await inventory(session,client);
      const plan=await prepare(session,client,input); plan.id=token();plan.input=input;plan.expires=Date.now()+15*60000;plan.digest=digest(plan);
      session.plans.clear();session.plans.set(plan.id,plan);
      return {...plan,steps:[...plan.configurations.map(c=>`Lock ${c.deviceId} → revalidate → ${c.operations.length} add/update calls → SaveActivateConfig → unlock`),...(plan.route?['Lock route set → revalidate → add/update entry → push to selected device groups → poll → commit → unlock']:[])]};
    }));
    if(url.pathname==='/api/apply') {const plan=session.plans.get(input.planId);if(!plan) throw new Error('Generate a preview first');return send(res,202,createJob(session,c=>apply(session,c,plan)));}
    return send(res,404,{error:'Not found'});
  } catch(error) {send(res,400,{error:redact(error.message)});}
});
setInterval(()=>{for(const [sid,s] of sessions) if(Date.now()-s.lastSeen>8*3600000 && ![...s.jobs.values()].some(j=>j.status==='running')) {sessions.delete(sid);if(s.mode==='live') s.client.request('POST','/admin/logout',s.client.credentials).catch(()=>{});}},60000).unref();
const port=Number(process.env.PORT || 9080), host=process.env.HOST || '127.0.0.1';
server.listen(port,host,()=>console.log(`SBC provisioning tool: ${tlsEnabled?'https':'http'}://${host}:${server.address().port}`));
async function shutdown() {
  if(shuttingDown)return;
  shuttingDown=true;
  console.log('Draining active jobs before shutdown');
  const deadline=Date.now()+270000;
  while([...sessions.values()].some(s=>[...s.jobs.values()].some(j=>j.status==='running')) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,500));
  await Promise.allSettled([...sessions.values()].filter(s=>s.mode==='live' && s.client.cookie).map(s=>s.client.request('POST','/admin/logout',s.client.credentials)));
  server.close(()=>process.exit(0));server.closeIdleConnections();
}
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
