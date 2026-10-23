// Keep the actual change/deployment requests, excluding authentication, reads and locks.
export function isChangeCall(entry) {
  let path;try{path=new URL(entry.url).pathname.replace(/\/$/,'');}catch{return false;}
  const method=String(entry.method).toUpperCase();
  if(method==='POST' && /\/configuration\/deviceConfigs\/[^/]+\/configElements\/(add|update|delete)$/.test(path))return true;
  if(['POST','PUT','DELETE'].includes(method) && /\/routeSets\/[^/]+\/entries(?:\/[^/]+)?$/.test(path))return true;
  if(method==='POST' && /\/configuration\/devices\/[^/]+\/action$/.test(path))return entry.request?.type==='SaveActivateConfig';
  if(method==='POST' && /\/routeSets\/[^/]+\/devices$/.test(path))return Array.isArray(entry.request?.assocDevices);
  if(method==='POST' && /\/routeSets\/[^/]+\/devices\/action$/.test(path))return entry.request?.action==='Update';
  return method==='POST' && /\/routeSets\/routeUpdates\/[^/]+\/action$/.test(path) && entry.request?.type==='Commit';
}
