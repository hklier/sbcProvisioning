const $=id=>document.getElementById(id);
const form=$('provisionForm');
const state={mode:'OC',connection:'demo',csrf:'',devices:[],routeSets:[],logs:[],plan:null,busy:false,editor:null};
const field=name=>form.elements.namedItem(name);
const selectedTargets=()=>[$('device').value,$('device2').value].filter(Boolean);
function showError(error) {
  const detail=error.failure || {message:error.message,rollback:{status:'unavailable'}};
  $('errorMessage').textContent=error.message;
  const status=detail.rollback?.status;
  const api=detail.api || detail.failedCalls?.[0];$('errorRest').textContent=api?`${api.method || ''} ${api.url || ''}${api.status?' · HTTP '+api.status:''}`:'';
  $('errorTargets').replaceChildren();for(const target of detail.rollback?.devices || []){const name=state.devices.find(d=>d.id===target.deviceId)?.name || target.deviceId;$('errorTargets').append(el('div',`${name} (${target.deviceId}): ${target.status}`,'plan-step'));}
  $('rollbackState').textContent=status==='restored'?'Automatic rollback completed and verified.':status==='incomplete'?'Rollback is incomplete. Review the failed recovery steps before retrying.':status==='not-needed'?'No provisioning changes needed rollback.':'Recovery status is unavailable. Check the job and REST activity before retrying.';
  $('errorDetails').textContent=JSON.stringify(detail,null,2);if(!$('errorDialog').open)$('errorDialog').showModal();
}
function el(tag,text,className) {const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
function showSuccess(plan) {
  $('successMessage').textContent=state.connection==='demo'?'Changes completed in Demo. No live SBC changes were made.':'All requested changes completed successfully.';
  const summary=$('successSummary');summary.replaceChildren();
  const labels={realmConfig:'realm',sipInterface:'SIP interface',sessionAgent:'session agent',sessionAgentGroup:'session group',localPolicy:'local policy'};
  for(const config of plan.configurations || []) {
    if(!config.operations.length)continue;
    const device=state.devices.find(d=>d.id===config.deviceId);
    summary.append(el('h3',`${device?.name || config.deviceId} (${config.deviceId})`,'count-heading'));
    for(const op of config.operations) {
      const object=op.body || op.before;
      const key=object.attributes?.find(a=>['id','RealmID','hostname','name'].includes(a.name))?.value || 'customer policy';
      const verb=op.path.endsWith('/delete')?'Deleted':op.path.endsWith('/add')?'Created':'Updated';
      summary.append(el('div',`${verb} ${labels[object.elementTypePath] || object.elementTypePath} · ${key}`,'plan-step'));
    }
    summary.append(el('p','Configuration saved and activated.','help'));
  }
  if(plan.routes?.length) {
    const set=state.routeSets.find(s=>String(s.routeSetId)===String(plan.routeSetId));
    summary.append(el('h3',`LRT · ${set?.name || plan.routeSetId}`,'count-heading'));
    for(const op of plan.routes) {
      const row=op.body || op.before;
      summary.append(el('div',`${op.method==='DELETE'?'Deleted':op.method==='PUT'?'Updated':'Added'} range · ${row.rangeStart} → ${row.rangeEnd}`,'plan-step'));
    }
    const targets=plan.deviceIds.map(id=>state.devices.find(d=>d.id===id)?.name || id).join(', ');
    summary.append(el('p',`Routing table deployed and committed on ${targets}.`,'help'));
  }
  $('successDialog').showModal();
}
function notice(text,error=false) {$('notice').hidden=!text;$('notice').textContent=text;$('notice').className=error?'error':'';}
function invalidate() {state.plan=null;$('previewCard').hidden=true;}
function setBusy(value) {state.busy=value;document.body.classList.toggle('busy',value);$('busy').hidden=!value;document.querySelectorAll('button,input,select,textarea').forEach(n=>{if(value){n.dataset.previousDisabled=String(n.disabled);n.disabled=true;}else{n.disabled=n.dataset.previousDisabled==='true';delete n.dataset.previousDisabled;}});}
async function api(path,data) {const response=await fetch('/api/'+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},body:data===undefined?undefined:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw new Error(result.error || `HTTP ${response.status}`);return result;}
function logEntry(entry) {
  if(!state.logs.length)$('activityLog').replaceChildren();
  state.logs.push(entry);const detail=el('details',undefined,'call'+(Number(entry.status)>=400 || entry.status==='ERROR'?' error':''));
  const summary=el('summary');let endpoint=entry.url;try{const url=new URL(entry.url);endpoint=url.pathname+url.search;}catch{}
  summary.append(el('span',entry.method,'method'),el('span',endpoint,'endpoint'),el('span',String(entry.status),'status'));detail.append(summary,el('small',`${new Date(entry.time).toLocaleTimeString()} · ${entry.durationMs} ms${entry.demo?' · DEMO':''}`));
  detail.append(el('div','Request','payload-label'),el('pre',entry.request===undefined?'(no body)':JSON.stringify(entry.request,null,2)),el('div','Response','payload-label'),el('pre',entry.response===null?'(empty response)':typeof entry.response==='string'?entry.response:JSON.stringify(entry.response,null,2)));
  const log=$('activityLog');const bottom=log.scrollHeight-log.scrollTop-log.clientHeight<100;log.append(detail);if(bottom)log.scrollTop=log.scrollHeight;
  $('callCount').textContent=`${state.logs.length} calls`;
}
async function run(path,data) {
  if(state.busy)throw new Error('An operation is already running');
  setBusy(true);notice('');$('jobState').textContent='Running';let seen=0;
  try {
    const {jobId}=await api(path,data);
    for(;;) {
      const job=await api('jobs/'+jobId);for(const entry of job.logs.slice(seen))logEntry(entry);seen=job.logs.length;
      if(job.status==='failed'){ $('jobState').textContent='Failed';throw Object.assign(new Error(job.error),{failure:job.failure}); }
      if(job.status==='complete'){ $('jobState').textContent='Complete';return job.result; }
      await new Promise(resolve=>setTimeout(resolve,700));
    }
  } catch(e) {$('jobState').textContent='Failed';throw e;} finally {setBusy(false);}
}
const action=fn=>async event=>{event?.preventDefault();try{await fn(event);}catch(e){notice(e.message,true);showError(e);}};
function updateDerived() {
  $('ocRealm').value='core-oc-bgid'+field('bgid').value.trim();$('olRealm').value=field('customerIdentifier').value.trim()+'-access';
  const prefix=state.mode==='OC'?field('bgid').value:field('lrtCustomerId').value+field('numberLength').value;
  $('rangePreview').textContent=`${prefix}${field('rangeStart').value} → ${prefix}${field('rangeEnd').value}`;
  $('lrtFields').hidden=field('scope').value==='config';$('lengthLabel').hidden=state.mode!=='OL';$('prefixLabel').hidden=state.mode!=='OL';
  $('associateLabel').hidden=field('scope').value==='config';
  $('configActionLabel').hidden=field('scope').value==='lrt';
}
function renderAgents() {
  const old=[...$('agents').querySelectorAll('input')].map(n=>n.value);$('agents').replaceChildren();
  for(let i=0;i<Number(field('agentCount').value);i++){const label=el('label',`Session agent ${i+1} · IP address`);const input=el('input');input.name='agentIp'+i;input.value=old[i] || (i===0?'172.22.250.226':'');input.placeholder=i===0?'172.22.250.226':'IPv4 or IPv6 address';label.append(input);$('agents').append(label);}
}
function selectMode(mode) {
  state.mode=mode;invalidate();document.querySelectorAll('[data-mode]').forEach(n=>n.setAttribute('aria-selected',String(n.dataset.mode===mode)));
  $('ocFields').hidden=mode!=='OC';$('olFields').hidden=mode!=='OL';$('formTitle').textContent=mode==='OC'?'Operator Connect':'Office Link';$('objectHint').textContent=mode==='OC'?'Realm + SIP interface':'Realm + agents + session group';
  $('filterLabel').textContent=mode==='OC'?'BGID':'Customer identifier';$('searchFilter').value=mode==='OC'?field('bgid').value:field('customerIdentifier').value;
  $('searchNumericId').value='';
  field('rangeStart').value=mode==='OC'?'371542577':'372818574';field('rangeEnd').value=mode==='OC'?'371542577':'372818576';
  chooseRouteSet();updateDerived();$('searchResults').replaceChildren(el('p','Enter a filter and search.','help'));
}
function chooseRouteSet() {const expected=state.mode==='OC'?'lookupAccessOc':'lookupAccessOl';const set=state.routeSets.find(r=>r.name===expected);if(set){$('routeSet').value=set.routeSetId;$('searchRouteSet').value=set.routeSetId;}}
function renderInventory(result) {
  state.devices=result.devices;state.routeSets=result.routeSets;state.connection=result.mode;
  const old=$('device').value;$('device').replaceChildren();for(const device of state.devices){const option=el('option',`${device.name} · ${device.ip} · ${device.nfName || device.nfId}${device.connectivityStatus===false?' · offline':''}`);option.value=device.id;$('device').append(option);}if(state.devices.some(d=>d.id===old))$('device').value=old;else if(state.devices.some(d=>d.id==='ID8'))$('device').value='ID8';
  const second=$('device2').value;$('device2').replaceChildren();const none=el('option','No second target');none.value='';$('device2').append(none);for(const device of state.devices){const option=el('option',`${device.name} · ${device.ip} · ${device.nfName || device.nfId}`);option.value=device.id;$('device2').append(option);}if(state.devices.some(d=>d.id===second))$('device2').value=second;
  $('demoFailureLabel').hidden=state.connection!=='demo';
  for(const name of ['routeSet','searchRouteSet']) {const select=$(name);const previous=select.value;select.replaceChildren();if(name==='searchRouteSet'){const empty=el('option','Skip LRT search');empty.value='';select.append(empty);}for(const set of state.routeSets){const option=el('option',`${set.name} · ${set.routeSetId}${String(set.lockState)==='true'?' · locked by '+(set.lockOwner || 'another session'):''}`);option.value=set.routeSetId;select.append(option);}if(state.routeSets.some(r=>String(r.routeSetId)===previous))select.value=previous;}
  chooseRouteSet();$('connectionBadge').textContent=state.connection==='demo'?'Demo environment':'Live SDM';$('connectionBadge').className='badge'+(state.connection==='live'?' live':'');$('environment').className='environment'+(state.connection==='live'?' live':'');
  $('environmentText').textContent=state.connection==='demo'?'Demo mode · Changes stay in this browser session’s simulated SDM.':`Live SDM · ${$('baseUrl').value} · Preview changes before applying${$('connectionForm').elements.labTls.checked?' · Lab TLS verification disabled':''}`;
}
function readInput() {
  const data=Object.fromEntries(new FormData(form));return {...data,associateTarget:field('associateTarget').checked,mode:state.mode,deviceIds:selectedTargets(),includeLrt:data.scope!=='config',networkInterface:state.mode==='OC'?data.ocNetwork:data.olNetwork,agentIps:[...$('agents').querySelectorAll('input')].map(n=>n.value.trim())};
}
function showPlan(plan) {
  state.plan=plan;$('previewCard').hidden=false;$('previewBadge').textContent=state.connection==='demo'?'Demo preview':'Live SDM preview';$('previewBadge').className='badge'+(state.connection==='live'?' live':'');
  const summary=$('planSummary');summary.replaceChildren();
  for(const step of plan.steps)summary.append(el('div',step,'plan-step'));
  for(const op of plan.associations || [])summary.append(el('div',`ASSOCIATE SBC GROUP · ${op.body.assocDevices.map(a=>a.deviceGroupId).join(', ')} · route set ${plan.routeSetId}`,'plan-step'));
  for(const config of plan.configurations)for(const op of config.operations){const key=op.body.attributes?.find(a=>['id','RealmID','hostname','name'].includes(a.name))?.value || 'local policy';summary.append(el('div',`${config.deviceId} · ${op.path.endsWith('/delete')?'DELETE':op.path.endsWith('/add')?'ADD':'UPDATE'} · ${op.body.elementTypePath} · ${key}`,'plan-step'));}
  for(const op of plan.routes || [])summary.append(el('div',`${op.method==='DELETE'?'DELETE':op.method==='PUT'?'UPDATE':'ADD'} LRT · ${(op.body || op.before).rangeStart} → ${(op.body || op.before).rangeEnd}`,'plan-step'));
  for(const warning of plan.warnings || [])summary.append(el('p',warning,'warning'));
  $('planJson').textContent=JSON.stringify(plan,null,2);$('applyPlan').textContent=state.connection==='demo'?'Apply in demo':'Apply to live SBC';$('previewCard').scrollIntoView({behavior:'smooth',block:'start'});
  $('deleteConfirmLabel').hidden=plan.kind!=='delete';$('deleteConfirm').checked=false;
  if(plan.kind==='delete')$('applyPlan').textContent=state.connection==='demo'?'Delete in demo':'Delete previewed customer data';
}
function view(name) {document.querySelectorAll('[data-view]').forEach(n=>n.classList.toggle('active',n.dataset.view===name));$('provisionView').hidden=name!=='provision';$('searchView').hidden=name!=='search';}
function openEditor(object,kind) {state.editor={kind};$('editorTitle').textContent=kind==='route'?'Inspect / edit LRT entry':'Inspect / edit configuration';$('objectEditor').value=JSON.stringify(object,null,2);$('editorDialog').showModal();}
function showResults(result) {
  const root=$('searchResults');root.replaceChildren(el('div',`${result.objects.length} configuration objects · ${result.routes.length} LRT entries`,'count-heading'));
  if(!result.objects.length && !result.routes.length)root.append(el('p','No matching entries found. Check the service, target device and numeric LRT prefix.','help'));
  for(const object of result.objects){const row=el('div',undefined,'result-row');const info=el('div',undefined,'result-info');const key=object.attributes?.find(a=>['id','RealmID','hostname','name'].includes(a.name))?.value || 'Local policy';info.append(el('h3',key),el('small',object.elementTypePath));const button=el('button','Inspect / edit','secondary');button.addEventListener('click',()=>openEditor(object,'config'));row.append(info,button);root.append(row);}
  for(const route of result.routes){const row=el('div',undefined,'result-row');const info=el('div',undefined,'result-info');info.append(el('h3',`${route.rangeStart} → ${route.rangeEnd}`),el('small',`LRT entry ${route.objectId}`));const button=el('button','Inspect / edit','secondary');button.addEventListener('click',()=>openEditor(route,'route'));row.append(info,button);root.append(row);}
}

document.querySelectorAll('[data-mode]').forEach(n=>n.addEventListener('click',()=>selectMode(n.dataset.mode)));
document.querySelectorAll('[data-view]').forEach(n=>n.addEventListener('click',()=>view(n.dataset.view)));
form.addEventListener('input',()=>{invalidate();updateDerived();});form.addEventListener('change',()=>{invalidate();updateDerived();});field('agentCount').addEventListener('change',renderAgents);
$('device').addEventListener('change',invalidate);$('searchForm').addEventListener('input',invalidate);$('searchForm').addEventListener('change',invalidate);
$('device2').addEventListener('change',invalidate);$('closeError').addEventListener('click',()=>$('errorDialog').close());
$('closeSuccess').addEventListener('click',()=>$('successDialog').close());
form.addEventListener('submit',action(async()=>showPlan(await run('preview',readInput()))));
$('searchForm').addEventListener('submit',action(async()=>{invalidate();const input=Object.fromEntries(new FormData($('searchForm')));showResults(await run('search',{...input,mode:state.mode,deviceId:$('device').value}));}));
$('previewDelete').addEventListener('click',action(async()=>{const input=Object.fromEntries(new FormData($('searchForm')));showPlan(await run('preview',{kind:'delete',mode:state.mode,deviceIds:selectedTargets(),filter:input.filter,numericId:input.numericId,scope:input.deleteScope,routeSetId:input.routeSetId,demoFailure:field('demoFailure').value}));}));
$('applyPlan').addEventListener('click',action(async()=>{if(!state.plan)throw new Error('Generate a new preview');if(state.plan.kind==='delete' && !$('deleteConfirm').checked)throw new Error('Review the deletion preview and select the confirmation checkbox.');const plan=state.plan;invalidate();const result=await run('apply',{planId:plan.id});notice(result.completed.join(' · '));showSuccess(plan);}));
$('discardPlan').addEventListener('click',invalidate);
$('refresh').addEventListener('click',action(async()=>{invalidate();renderInventory(await run('inventory',{}));notice('Inventory refreshed.');}));
$('connectionButton').addEventListener('click',()=>{$('connectionMode').value=state.connection;$('connectionDialog').showModal();});$('closeConnection').addEventListener('click',()=>$('connectionDialog').close());
$('connectionForm').addEventListener('submit',action(async()=>{const input={mode:$('connectionMode').value,labTls:$('connectionForm').elements.labTls.checked};$('connectionDialog').close();invalidate();renderInventory(await run('connect',input));notice(input.mode==='live'?'Connected to live SDM. Inventory read successfully.':'Demo connected. No requests are sent to SDM.');}));
$('closeEditor').addEventListener('click',()=>$('editorDialog').close());
$('previewEdit').addEventListener('click',action(async()=>{const object=JSON.parse($('objectEditor').value);const input=state.editor.kind==='route'?{kind:'routeEdit',scope:'lrt',deviceIds:selectedTargets(),routeSetId:$('searchRouteSet').value,entryId:object.objectId,route:object}:{kind:'edit',scope:'config',deviceIds:selectedTargets(),object};$('editorDialog').close();showPlan(await run('preview',input));}));
$('clearLog').addEventListener('click',()=>{state.logs=[];$('activityLog').replaceChildren(el('p','Activity cleared.','help'));$('callCount').textContent='0 calls';});
$('exportLog').addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(state.logs,null,2)],{type:'application/json'}));const a=el('a');a.href=url;a.download=`sbc-rest-activity-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
renderAgents();updateDerived();
action(async()=>{const status=await api('status');state.csrf=status.csrf;$('baseUrl').value=status.baseUrl;$('credentialState').textContent=status.credentialsAvailable?'SDM credentials are available to the backend. They are never sent to this page.':'Set the server’s credential file or environment variables before connecting to live SDM.';renderInventory(await run('connect',{mode:'demo'}));})();
