import {TYPES,attr,selector,configRoot,cleanConfig} from './provisioning.js';
const ordered=['localPolicy','sipInterface','sessionAgentGroup','sessionAgent','realmConfig'];
export async function allObjects(client,device) {
  const rows=[];
  for(const type of TYPES) for(const key of await client.list(`${configRoot(device)}?elementTypePath=${type}`,'configElements')) rows.push(await client.request('POST',`${configRoot(device)}/retrieve`,selector(key)));
  return rows;
}
function values(e){return [...(e.attributes || []).map(a=>a.value),...(e.childrenElements || []).flatMap(values)];}
export function customerObjects(objects,mode,filter,numericId='') {
  filter=String(filter || '').trim();numericId=String(numericId || '').trim();
  if(!['OC','OL'].includes(mode) || !filter || (mode==='OC' && !/^\d+$/.test(filter)))throw new Error('Deletion requires an exact OC BGID or OL customer identifier / numeric ID');
  const identifiers=new Set(),numbers=new Set();
  if(mode==='OL') {
    if(/^\d+$/.test(filter))numbers.add(filter);else if(/^[\w-]+$/.test(filter))identifiers.add(filter);else throw new Error('Invalid customer identifier');
    if(numericId){if(!/^\d+$/.test(numericId))throw new Error('Invalid numeric OL customer ID');numbers.add(numericId);}
    for(const e of objects) {
      const realm=attr(e,'id'),host=attr(e,'hostname'),hmr=attr(e,'hmrString');
      const name=e.elementTypePath==='realmConfig' && realm?.endsWith('-access')?realm.slice(0,-7):e.elementTypePath==='sessionAgent'?host?.match(/^(.*)-[1-4]$/)?.[1]:undefined;
      if(name && (/^\d+$/.test(filter)?numbers.has(hmr):identifiers.has(name))) {identifiers.add(name);if(/^\d+$/.test(hmr))numbers.add(hmr);}
    }
    if(identifiers.size>1 || numbers.size>1)throw new Error('Ambiguous customer mapping. Use one exact identifier and its matching numeric OL ID.');
  }
  const realms=new Set(mode==='OC'?[`core-oc-bgid${filter}`]:[...identifiers].map(i=>`${i}-access`));
  const groups=new Set([...identifiers].map(i=>`${i}.corporate.vodafone.ro`));
  const selected=objects.filter(e=>{
    if(e.elementTypePath==='realmConfig')return realms.has(attr(e,'id'));
    if(e.elementTypePath==='sipInterface')return realms.has(attr(e,'RealmID'));
    if(e.elementTypePath==='sessionAgent')return mode==='OL' && [...identifiers].some(i=>[1,2,3,4].some(n=>attr(e,'hostname')===`${i}-${n}`));
    if(e.elementTypePath==='sessionAgentGroup')return groups.has(attr(e,'name'));
    // Shared/global policies and parent realms are deliberately not customer-owned.
    if(e.elementTypePath==='localPolicy')return (e.childrenElements || []).some(c=>c.elementTypePath==='localPolicy/sourceRealm' && (c.attributes || []).some(a=>realms.has(a.value)));
    return false;
  });
  return {objects:selected.sort((a,b)=>ordered.indexOf(a.elementTypePath)-ordered.indexOf(b.elementTypePath)),identifiers:[...identifiers],numericIds:[...numbers],realms:[...realms]};
}
export async function prepareDeletion(client,devices,input) {
  if(!['config','lrt','both'].includes(input.scope))throw new Error('Choose configuration, LRT, or both for deletion');
  const configurations=[],ownership=[];
  const knownPrefixes=new Set();
  for(const device of devices) {
    await cleanConfig(client,device.id);
    const all=await allObjects(client,device.id);
    for(const e of all){const value=input.mode==='OC' && e.elementTypePath==='realmConfig'?attr(e,'id')?.match(/^core-oc-bgid(\d+)$/)?.[1]:input.mode==='OL'?attr(e,'hmrString'):undefined;if(/^\d+$/.test(value || ''))knownPrefixes.add(value);}
    const owned=customerObjects(all,input.mode,input.filter,input.numericId);ownership.push(owned);
    if(input.scope!=='lrt')configurations.push({deviceId:device.id,operations:owned.objects.map(before=>({method:'POST',path:`${configRoot(device.id)}/delete`,body:selector(before),before}))});
  }
  const numericIds=[...new Set(ownership.flatMap(o=>o.numericIds))];
  if(input.mode==='OL' && numericIds.length>1)throw new Error('The targets map to different numeric customer IDs; deletion stopped');
  const routes=[];let routeSnapshot;
  if(input.scope!=='config') {
    if(!input.routeSetId)throw new Error('Select the customer route set');
    if(input.mode==='OL' && !numericIds.length)throw new Error('No numeric OL LRT ID could be resolved. Enter the numeric customer ID explicitly.');
    routeSnapshot=await client.list(`/routeSets/${encodeURIComponent(input.routeSetId)}/entries/`,'routeSetEntries');
    const prefix=input.mode==='OC'?String(input.filter).trim():numericIds[0];
    const selected=routeSnapshot.filter(r=>String(r.rangeStart).startsWith(prefix) && String(r.rangeEnd).startsWith(prefix));
    if(selected.some(r=>[...knownPrefixes].some(other=>other!==prefix && other.startsWith(prefix) && (String(r.rangeStart).startsWith(other)||String(r.rangeEnd).startsWith(other)))))throw new Error('LRT prefix also matches a different known customer ID. Use an unambiguous exact customer ID.');
    for(const before of selected)routes.push({method:'DELETE',path:`/routeSets/${encodeURIComponent(input.routeSetId)}/entries/${encodeURIComponent(before.objectId)}`,before});
  }
  if(!configurations.some(c=>c.operations.length) && !routes.length)throw new Error('No customer-owned objects or LRT entries match this exact customer selection');
  return {configurations,routes,routeSnapshot,kind:'delete',warnings:['Deletion is based on exact customer object names and exact hmrString mappings. Review every selected object and LRT range. Shared parent realms and global policies are excluded.','A failed step triggers automatic restoration and verification on both selected targets. Any failed recovery step is reported explicitly.']};
}
