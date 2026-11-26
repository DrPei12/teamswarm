// Runs a synthetic project through installed Harnesses and an explicitly selected DeepSeek account.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '../../teamswarm/node_modules/playwright/index.mjs';
import { verifyBuild } from '../../scripts/release-identity.mjs';

const repo=process.cwd(), build=verifyBuild(repo), upstream='https://api.deepseek.com';
const reference=process.env.TEAMSWARM_AUDITED_REFACTOR_CREDENTIAL;
assert(/^TEAMSWARM_KEY_[A-Z0-9_]+$/.test(reference??'') && process.env.TEAM_DATA_DIR,
  'Set TEAMSWARM_AUDITED_REFACTOR_CREDENTIAL to an existing DeepSeek credential reference and TEAM_DATA_DIR to its store.');
const secret=JSON.parse(await fs.readFile(path.join(process.env.TEAM_DATA_DIR,'credentials.json'),'utf8'))[reference];
assert(typeof secret==='string' && secret.length,'No value is available for the selected account.');
const profile='architecture-audited-refactor-'+randomUUID().slice(0,8), home=path.join(repo,'.local','rework',profile);
const workspace=path.join(home,'projects','task-report'), accounts=path.join(home,'data');
const secretCopy=path.join(accounts,'credentials.json');
await fs.mkdir(workspace,{recursive:true});await fs.mkdir(accounts,{recursive:true});
const digest=x=>createHash('sha256').update(x).digest('hex');
const safe=x=>String(JSON.stringify(x,null,2)).replaceAll(secret,'[redacted]').replaceAll(reference,'[credential-reference]');
const checked=['tasks.json','verify.mjs','verify-followup.mjs'];
for(const name of checked)await fs.copyFile(path.join(repo,'examples','task-report',name),path.join(workspace,name),1);
const inputFingerprints=Object.fromEntries(await Promise.all(checked.map(async name=>[name,digest(await fs.readFile(path.join(workspace,name)))])));
const legacy=`import fs from 'node:fs';
const data=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const byStatus={open:0,done:0,blocked:0};
for(const task of data)byStatus[task.status]++;
console.log(JSON.stringify({total:data.length,byStatus}));
`;
await fs.writeFile(path.join(workspace,'legacy-report.mjs'),legacy,{flag:'wx'});
const result={profile,entry:'npm run start:rework',commit:build.commit,sourceSha256:build.sourceSha256,inputFingerprints,
  provider:'DeepSeek Chat Completions',harnesses:{host:'deepseek-harness',producer:'pi',reviewer:'claude-code'},rounds:[]};
let child,browser,connection,serviceErrors='';
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/API_KEY|CREDENTIAL|TOKEN|PASSWORD|SECRET|^TEAM_|^TEAMSWARM_|^CODEX_HOME|^NODE_OPTIONS$/i.test(key)));
async function start(){
  const reservation=createServer().listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  child=spawn(process.execPath,['scripts/start-rework.mjs','--no-open'],{cwd:repo,windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],
    env:{...env,TEAMSWARM_REWORK_PROFILE:profile,TEAMSWARM_REWORK_PORT:String(port),TEAMSWARM_SUPERVISOR_DIR:path.join(home,'supervisor')}});
  child.stderr.on('data',chunk=>{serviceErrors=(serviceErrors+String(chunk).replaceAll(secret,'[redacted]')).slice(-6000);});
  const ready=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Isolated product did not report readiness.')),30000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);reject(Error('Service exited '+code));});
    child.on('message',message=>{if(message?.type==='ready'){clearTimeout(timer);resolve(message);}});
  });
  assert.equal(ready.port,port);connection={token:ready.token,origin:'http://127.0.0.1:'+port};
}
async function stop(){
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  const ended=once(child,'exit');child.send({type:'shutdown'});const limit=setTimeout(()=>child.kill(),18000);
  try{assert.deepEqual(await ended,[0,null]);}finally{clearTimeout(limit);}
}
async function api(route,body,method=body?'POST':'GET'){
  const response=await fetch(connection.origin+'/api'+route,{method,headers:{Authorization:`Bearer ${connection.token}`,'content-type':'application/json'},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)}).catch(error=>{
      throw Error(`${method} ${route} failed: ${error.cause?.code??error.message}`,{cause:error});
    });
  const value=await response.json();assert(response.ok,`${method} ${route} returned ${response.status}: ${safe(value.error)}`);return value;
}
async function wait(name,observe,maxMs=220000){
  const end=Date.now()+maxMs;
  while(Date.now()<end){const value=await observe();if(value)return value;await delay(450);}
  throw Error(`${name} did not arrive by the acceptance deadline.`);
}
const config=(harness,access,permissions)=>({harness,model:'deepseek-flash',provider:'DeepSeek',baseUrl:upstream,
  protocol:'chat-completions',credentialEnv:reference,effort:'low',access,permissions});
const producedFiles=['report.mjs','summary.md'];
const onDisk=async name=>fs.stat(path.join(workspace,name)).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
const finalContract='The Node task report supports the original JSON command and --status; both supplied verification programs pass without changing their files or tasks.json.';
const initialContract='The migrated Node task report validates the complete input, returns the correct totals and passes the supplied verify.mjs suite without changing the supplied fixtures.';
try{
  await fs.writeFile(secretCopy,JSON.stringify({[reference]:secret}),{mode:0o600,flag:'wx'});
  await start();
  const hostConfig=config('deepseek-harness','read-only',{harness:'deepseek-harness',sandbox:'read-only',approval:'never'});
  const producerConfig=config('pi','workspace-write',{harness:'pi',tools:['read','write','edit']});
  const reviewerConfig=config('claude-code','read-only',{harness:'claude-code',mode:'dontAsk'});
  const team=await api('/product/teams',{name:'Isolated report migration',workspace,clientRequestId:randomUUID()});
  const scope='/teams/'+team.id;
  const runtime=await api(scope+'/runtime');
  await api(scope+'/runtime',{expectedVersion:runtime.settings.version,workspace,config:hostConfig,timeoutSeconds:110},'PUT');
  const settings=await api(scope+'/capabilities');
  await api(scope+'/capabilities',{expectedVersion:settings.version,enabledHarnesses:['deepseek-harness','pi','claude-code'],
    connections:[{id:'deepseek',name:'DeepSeek',kind:'api',enabled:true,subscriptionHarness:null,credentialEnv:reference,
      endpoints:{'chat-completions':upstream},models:[producerConfig.model]}],
    preferences:{priority:'balanced',preferSubscription:false,instructions:'Use the agreed model connection.',workerPolicy:'autonomous'}},'PUT');
  const producer=await api(scope+'/members',{name:'Report engineer',responsibility:'Migrate the command and preserve its public behavior',config:producerConfig,clientRequestId:randomUUID()});
  const reviewer=await api(scope+'/members',{name:'Report verifier',responsibility:'Independently run the supplied test files against the exact frozen candidate',config:reviewerConfig,clientRequestId:randomUUID()});
  const input=(content,clientRequestId=randomUUID())=>api(scope+'/conversations/'+team.mainChatId+'/messages',{content,clientRequestId});
  const works=async()=>(await api(scope+'/runtime')).works;
  const exact=work=>api(scope+'/works/'+work.id);
  const revision=criterion=>({content:criterion,affectedWorkIds:[],outcome:{expectedRequirementId:null,specification:{
    valueGoal:'Migrate the legacy reporting command safely',invariants:['Do not edit legacy-report.mjs, tasks.json or either verifier.'],
    criteria:[{key:'report',text:criterion}],nonGoals:['A new UI or dependency.']}}});
  const plan={expectedRevision:0,upsert:[{key:'migration',title:'Migrate the reporting command',assigneeMemberId:producer.id,dependsOn:[],outcomeCriteria:['report']}],remove:[]};
  const assignment={memberId:producer.id,title:'Migrate the reporting command',
    instructions:'Stage a compatibility candidate by copying legacy-report.mjs as report.mjs without changing its behavior, and add a summary.md describing current limitations. This is a deliberately unchanged migration candidate for independent regression detection, not a passing implementation. Submit both files for the verifier, without claiming the checks passed.',
    acceptanceCriteria:[initialContract],acceptanceEvidence:[{criterion:initialContract,evidenceType:'native_check'}],workspaceMode:'isolated',verification:'independent',
    writePaths:producedFiles,inputArtifactIds:[],dependsOn:[],workflowNodeKey:'migration',expectedWorkflowRevision:1};
  const command=files=>[process.execPath,'--input-type=module','-e',`import{spawnSync}from'node:child_process';for(const file of ${JSON.stringify(files)}){const p=spawnSync(process.execPath,[file],{encoding:'utf8'});process.stdout.write(p.stdout??'');process.stderr.write(p.stderr??'');if(p.error||p.status!==0)process.exit(Number.isInteger(p.status)?p.status:1);}`];
  const reviewInstructions=files=>`Read the target work and every exact submitted artifact (including the result summary). Run team_review_command with ${JSON.stringify({argv:command(files)})}. Take the command's evidenceEventId. For each original criterion, record its exact text, native_check and the returned event ID in team_accept_work. Accept only when the command succeeded and every criterion passed. If the command failed, record rejected and include the observed failure. Do not alter source or rerun an older candidate.`;
  const sent=await input(`Audit the existing task-report CLI migration. Preserve the original v1 candidate for the regression verdict, do not launch repairs until I confirm the revised contract. Call team_define_requirements with ${JSON.stringify(revision(initialContract))}. Call team_plan_workflow with ${JSON.stringify(plan)}. Delegate the migration node via team_delegate with ${JSON.stringify(assignment)}. Once submitted, assign independent reviewer ${reviewer.id} via team_review, using these instructions: ${reviewInstructions(['verify.mjs'])} Keep the rejection available for repair; do not substitute a self-check.`);
  const first=await wait('independently rejected initial candidate',async()=>{
    const all=await works(), target=all.find(w=>w.memberId===producer.id&&w.workflowNodeKey==='migration');
    if(target?.status==='rejected')return target;
    const error=all.find(w=>[producer.id,reviewer.id].includes(w.memberId)&&['failed','recovery_required'].includes(w.status));
    if(error)throw Error(`${error.title}: ${error.error}`);
  });
  assert(first.candidateSnapshotId&&first.attemptId);
  reportCandidate(first,'rejected');
  assert(!(await onDisk('report.mjs')),'A rejected candidate must not reach the mainline.');
  const oldRun=(await exact(await wait('initial Host work',async()=>(await works()).find(w=>w.id===sent.workId)))).work.runId;
  const branch=(await api(scope+'/branches')).branches[0].id;
  const outcomeBefore=await api(scope+'/branches/'+branch+'/outcome');
  await stop();await start();
  const after=(await exact(first)).work;
  assert.equal(after.status,'rejected');assert.equal(after.candidateSnapshotId,first.candidateSnapshotId);
  result.restarted=true;
  const repairId=randomUUID();
  const revisedRequest=`The audit found the legacy CLI accepts invalid input. Update the project contract now: ${finalContract} Use only the Node standard library. Validate all rows before applying a filter: unique, nonempty string IDs; nonempty string titles; status open, done or blocked. Reject malformed JSON, invalid rows, unknown options, duplicate filters or missing arguments with nonzero exit code, empty stdout, and useful stderr. Keep old invocation working and put all three counts in the JSON. Leave every supplied file unchanged. Record a new outcome contract that supersedes the earlier criteria and references the rejected migration and its findings. Coordinate a repair by ${producer.id}, using the prior candidate explicitly as an input or continuing its thread under the new effective requirements; assign only ${producedFiles.join(' and ')} for writing. Bind a new workflow with its acceptance criterion based on the revised output, not the old result. Once the repair submits, assign independent reviewer ${reviewer.id} via team_review and provide these instructions: ${reviewInstructions(['verify.mjs','verify-followup.mjs'])} The reviewer must run both checks on the new frozen candidate. End with the accepted published bytes and both review records traceable in the project history.`;
  const followup=await input(revisedRequest,repairId);
  const duplicate=await input(revisedRequest,repairId);assert.equal(duplicate.workId,followup.workId);
  const second=await wait('verified repaired version on the mainline',async()=>{
    const all=await works(), target=all.find(w=>w.id!==first.id&&w.memberId===producer.id&&w.verification==='independent'&&w.status==='accepted'&&w.publication?.state==='published');
    if(target)return target;
    const stopped=all.find(w=>w.id!==first.id&&[producer.id,reviewer.id].includes(w.memberId)&&['failed','recovery_required'].includes(w.status));
    if(stopped)throw Error(`${stopped.title}: ${stopped.error}`);
  });
  assert.notEqual(second.candidateSnapshotId,first.candidateSnapshotId);reportCandidate(second,'published');
  const outcomeAfter=await api(scope+'/branches/'+branch+'/outcome');
  assert.notDeepEqual(outcomeAfter,outcomeBefore);assert(JSON.stringify(outcomeAfter).includes('--status'));
  const detail=await exact(second);
  const actual=await fs.readFile(path.join(workspace,'report.mjs'));assert.equal(detail.artifacts.find(a=>a.path==='report.mjs').sha256,digest(actual));
  for(const name of checked)assert.equal(digest(await fs.readFile(path.join(workspace,name))),inputFingerprints[name]);
  assert.equal(await fs.readFile(path.join(workspace,'legacy-report.mjs'),'utf8'),legacy);
  result.externalChecks=checked.filter(name=>name.startsWith('verify')).map(name=>{
    const ran=spawnSync(process.execPath,[path.join(workspace,name)],{cwd:workspace,encoding:'utf8',timeout:60000});assert.equal(ran.status,0,ran.stderr);return JSON.parse(ran.stdout);
  });
  const history=await api(scope+'/history');assert(history.nodes.some(node=>node.kind==='acceptance'));
  const all=await works();const reviews=await Promise.all(all.filter(w=>[first.id,second.id].includes(w.reviewOf)).map(exact));
  assert(reviews.some(r=>r.work.reviewOf===first.id&&r.attempts.some(a=>a.config.harness==='claude-code')));
  assert(reviews.some(r=>r.work.reviewOf===second.id&&r.attempts.some(a=>a.config.harness==='claude-code')));
  result.reviews=reviews.map(({work,attempts})=>({id:work.id,target:work.reviewOf,attempts:attempts.map(a=>({id:a.id,sessionId:a.sessionId,modelRequest:a.modelRequest?.id}))}));
  result.runs=[oldRun,second.runId];
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({locale:'en-US',viewport:{width:1280,height:900},reducedMotion:'reduce'});
  assert((await context.request.post(connection.origin+'/api/control/session',{headers:{Authorization:`Bearer ${connection.token}`}})).ok());
  const page=await context.newPage(), errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(connection.origin+'/#/team/'+team.id+'/history');
  await page.getByRole('button',{name:'Current position',exact:true}).click();
  await page.locator('.history-detail summary').filter({hasText:'Result contract'}).click();
  await page.getByRole('region',{name:'Execution workflow'}).waitFor();
  assert.deepEqual(errors,[]);
  result.passed=true;
}catch(error){result.passed=false;result.error=error.message;process.exitCode=1;}
finally{
  try{await browser?.close();await stop();}catch(error){result.cleanupError=error.message;result.passed=false;process.exitCode=1;}finally{
    if(serviceErrors)await fs.writeFile(path.join(home,'service.log'),serviceErrors.replaceAll(reference,'[credential-reference]'),{flag:'wx'});
    await fs.unlink(secretCopy).catch(error=>{if(error.code!=='ENOENT')throw error;});
    await fs.writeFile(path.join(home,'acceptance.json'),safe(result)+'\n',{flag:'wx'});
    console.log(safe({profile,passed:result.passed,error:result.error,rounds:result.rounds}));
  }
}
function reportCandidate(work,state){result.rounds.push({state,id:work.id,attemptId:work.attemptId,snapshot:work.candidateSnapshotId,artifactIds:work.artifactIds});}
