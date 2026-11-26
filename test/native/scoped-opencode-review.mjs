// Run after the server build, on Windows x64 with the pinned OpenCode plugin SDK installed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { ModelGateway } from '../../apps/server/dist/runtime/model-gateway.js';
import { NativeHarness } from '../../apps/server/dist/runtime/harness/native.js';
import { executeScopedReview } from '../../apps/server/dist/runtime/harness/scoped-review-execution.js';
import { conflict } from '../../apps/server/dist/errors.js';
import { createApp } from '../../apps/server/dist/app.js';
import { runtimeSettings } from '../../apps/server/dist/runtime/validation.js';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teamswarm-review-'));
const candidate = path.join(directory, 'candidate'), source = path.join(candidate, 'example.txt');
fs.mkdirSync(candidate);
const content = randomUUID();
fs.writeFileSync(source, content);
const digest = createHash('sha256').update(content).digest('hex');
const credentialEnv = 'TEAMSWARM_OPENCODE_REVIEW_FIXTURE';
Object.assign(process.env, { TEAM_HARNESS_HOME: path.join(directory, 'harness'),
  TEAMSWARM_SUPERVISOR_DIR: path.join(directory, 'supervisor'), [credentialEnv]: 'loopback-fixture' });
const config = { harness: 'opencode', protocol: 'chat-completions', baseUrl: 'https://api.deepseek.com',
  credentialEnv, model: 'deepseek-flash', provider: 'DeepSeek', access: 'read-only' };
const nativeFetch = globalThis.fetch;
const gateway = new ModelGateway(path.join(directory, 'gateway'));
const native = new NativeHarness('opencode');
const execute = native.execute.bind(native);
let checkLease;
native.execute = async request => {
  checkLease = () => fetch(request.config.baseUrl + '/chat/completions', {method:'POST', headers:{
    authorization:'Bearer ' + request.modelRoute.token, 'content-type':'application/json', 'x-opencode-session-id':'unbound-root',
  }, body:JSON.stringify({model:config.model,messages:[{role:'user',content:'Unbound turn'}]})}).then(async r => { await r.text(); return r.status; });
  assert.equal(await checkLease(),403,'Reject model requests before the native root is bound.');
  return execute(request);
};
const harness = gateway.wrap(native);
let respond, fixtureError;
const upstream = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/chat/completions');
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString());
    const answer = respond(body);
    const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({ id: 'model-' + randomUUID(), model: body.model,
      created: Math.floor(Date.now()/1000), object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end((typeof answer === 'string' ? chunk({ role:'assistant', content: answer }, null) + chunk({}, 'stop') :
      chunk({ role:'assistant', tool_calls: [{ index:0, id: 'call_' + randomUUID(), type:'function',
        function: { name: answer.name, arguments: JSON.stringify(answer.args) } }] }, null) + chunk({}, 'tool_calls')) + 'data: [DONE]\n\n');
  } catch (error) {
    fixtureError ??= error;
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error:String(error) }));
  }
}).listen(0, '127.0.0.1');
await once(upstream, 'listening');
const upstreamOrigin = 'http://127.0.0.1:' + upstream.address().port;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === config.baseUrl) return nativeFetch(new URL(url.pathname, upstreamOrigin), init);
  assert.equal(url.hostname, '127.0.0.1', 'This fixture does not allow external fetch.');
  return nativeFetch(input, init);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function run(phase) {
  let controlId, turnId, nativeId, receipt, verdict, current = true, reads = 0, steps = 0, finished = false;
  const events = [], model = [];
  const scratch = path.join(directory, phase);
  const output = path.join(scratch, 'running'), finish = path.join(scratch, 'finish');
  const names = ['team_read_file', 'team_review_command', 'team_accept_work'];
  const tool = name => ({ name, description: name, inputSchema: { type:'object', properties:
    name === 'team_read_file' ? { path: {type:'string'} } : { evidence: {type:'string'} } } });
  const candidateCheck = `const fs=require('node:fs'),p=require('node:path'),a=require('node:assert/strict');const [f,d]=process.argv.slice(1);` +
    `a.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex'),${JSON.stringify(digest)});` +
    `a.throws(()=>fs.appendFileSync(f,'modified'),e=>['EPERM','EACCES'].includes(e.code));a.equal(process.env.TEAMSWARM_OPENCODE_SIGNER_KEY,undefined);` +
    `fs.writeFileSync(p.join(d,'running'),'scratch');` + (phase === 'complete' ? `console.log('verified')` :
    `const t=setInterval(()=>{if(fs.existsSync(p.join(d,'finish'))){clearInterval(t);console.log('verified')}},50);`);
  respond = body => {
    const registry = (body.tools ?? []).map(t => t.function.name);
    if (!registry.length) return 'Review';
    // The adjudicator never receives bash, write, native read, task, plugins, or even the internal receipt field.
    assert(!JSON.stringify(body).includes('_teamswarmReceipt'));
    assert.deepEqual(registry.slice().sort(), names.map(t => 'teamswarm_' + t).sort());
    steps++;
    if (steps === 1) return { name:'teamswarm_team_read_file', args:{path:'example.txt'} };
    const result = JSON.stringify(body.messages.at(-1));
    if (steps === 2) {
      assert(result.includes(digest), result);
      return { name:'teamswarm_team_review_command', args:{argv:[process.execPath,'-e',candidateCheck,source,scratch],timeoutMs:22000} };
    }
    if (phase !== 'complete') return 'The candidate was not accepted.';
    if (steps === 3) {
      assert(receipt && result.includes(receipt) && result.includes('verified'), result);
      return { name:'teamswarm_team_accept_work', args:{evidence:receipt} };
    }
    assert.equal(steps, 4); assert(verdict); return 'The candidate passed.';
  };
  const operation = executeScopedReview(harness, {
    workspace:candidate, config, executionRequirements:{nativeCommands:true}, verificationDirectory:scratch,
    isolatedWorkspace:true, instructions:'Verify the candidate independently.', input:'Review example.txt.',
    tools:['team_read_file','team_accept_work','team_edit_file','team_preview_start'].map(tool),
    onSession(id, actual) { controlId=id; assert.equal(actual.detachedReviewCommands,true); assert.equal(actual.nativeCommands,false); },
    onTurn(id) { turnId=id; },
    onDispatch(owner) { assert.equal(owner.turnId,turnId); nativeId=owner.sessionId; assert.notEqual(nativeId,controlId); },
    onEvent(event) { if(event.type==='model.request') model.push(event.data); events.push(event); },
    assertReviewCommand() { if(!current) throw conflict('review_check_outdated','Review candidate changed.'); },
    recordReviewCommand(data) {
      assert(current); assert.equal(data.cwd,candidate); assert.equal(data.exitCode,0, data.output); assert.equal(data.reviewCommandLane,true);
      assert.match(data.id,/^[a-f0-9]{64}$/); assert(!receipt); return receipt='receipt-'+randomUUID();
    },
    async onTool(name,args,_callId,signal,scope) {
      assert(!signal.aborted); assert.equal(scope.sessionId,nativeId); assert.equal(scope.threadId,nativeId); assert.equal(scope.turnId,turnId);
      if(name==='team_read_file') { reads++; assert.deepEqual(args,{path:'example.txt'}); return {sha256:digest}; }
      assert.equal(name,'team_accept_work'); assert.equal(phase,'complete'); assert(current && receipt); assert.deepEqual(args,{evidence:receipt});
      verdict=true; current=false; return {verdict:'accepted'};
    },
  }).finally(()=>{finished=true;});
  // Drive cancellation/replacement only after the actual sandboxed command writes its own marker.
  const deadline=Date.now()+90000;
  try {
    while(!finished && !fixtureError && Date.now()<deadline && !fs.existsSync(output)) await sleep(50);
    if(fixtureError) throw fixtureError;
    if(!fs.existsSync(output)) throw new Error('No command marker: '+JSON.stringify(finished?await operation:'timeout'));
    if(phase==='cancel') await harness.interrupt(controlId,turnId);
    while(!finished && Date.now()<deadline) await sleep(50);
    if(!finished) throw new Error('Review did not finish before the fixture deadline.');
    const result=await operation;
    assert.equal(await checkLease(),403,'The model route is closed at the terminal boundary.');
    if(fixtureError) throw fixtureError;
    assert.equal(reads,1); assert(model.length && model.every(m=>m.nativeRootSessionId===nativeId && m.nativeThreadId===nativeId && m.nativeTurnId===turnId));
    assert.equal(Boolean(receipt),phase==='complete'); assert.equal(Boolean(verdict),phase==='complete');
    if(phase==='complete') assert.equal(result.status,'completed',result.error);
    if(phase==='cancel') assert.equal(result.status,'interrupted',result.error);
    const start=events.find(e=>e.type==='review.command_runner_started');
    assert(start && events.some(e=>e.type==='review.command_runner_released' && e.data.id===start.data.id && Number.isInteger(e.data.pid)));
    assert(events.some(e=>e.type==='resource.released')); assert.equal(fs.readFileSync(source,'utf8'),content);
    return {phase,status:result.status,root:nativeId,turn:turnId,receipt:receipt??null,verdict:verdict===true,commandReleased:true,nativeReleased:true};
  } finally {
    if(!finished) { if(controlId && turnId) await harness.interrupt(controlId,turnId); else await harness.close(); }
    await operation.catch(()=>{});
  }
}
// Seed a synthetic production submission. Only the producer's input is seeded; the real review must publish it.
async function runPublication(replace) {
  const project=path.join(directory,replace?'replacement-project':'project'), dataDir=path.join(directory,replace?'replacement-data':'data');
  fs.mkdirSync(project);
  const reviewerHarness=new NativeHarness('opencode');
  const execute=reviewerHarness.execute.bind(reviewerHarness);
  // Never dispatch background coordination or the replacement producer to any model in this fixture.
  reviewerHarness.execute=request=>request.signedRootReview ? execute(request) : Promise.resolve({status:'interrupted',text:'Fixture seeds production only.'});
  const service=createApp({dataDir, harnesses:[reviewerHarness]});
  const {store,history,workspaces,records,catalog}=service.runtime;
  const criterion='The published example matches its submitted bytes.';
  try {
    const team=service.store.createTeam('Isolated review',''), chat=service.store.createConversation(team.id,'Review',null);
    const {expectedVersion,...settings}=runtimeSettings.parse({workspace:project,config,expectedVersion:0,timeoutSeconds:100});
    store.configure(team.id,settings,expectedVersion);
    const capabilities=catalog.capabilities.read(team.id);
    catalog.capabilities.save(team.id,{expectedVersion:capabilities.version,enabledHarnesses:['opencode'],connections:[{
      id:'fixture',name:'Fixture connection',kind:'api',enabled:true,subscriptionHarness:null,endpoints:{'chat-completions':config.baseUrl},credentialEnv,models:[config.model]}],preferences:capabilities.preferences});
    let host;
    service.store.recordMessage(team.id,chat.id,criterion,randomUUID(),m=>{host=store.enqueueHost(team.id,chat.id,m.id,true,false)});
    store.publishRequirement(host,criterion,[]); store.setStatus(host,'submitted');
    const run=store.get('runs',team.id,host.runId), branch=history.forRun(run);
    const producer=store.createMember(team.id,'Producer','Prepare the candidate',{...config,access:'workspace-write'},branch.id);
    const reviewer=store.createMember(team.id,'Reviewer','Check the candidate',config,branch.id);
    const target=store.createWork(run,producer.id,'Example','Supply example.txt',[criterion],[],[]);
    Object.assign(target,{workspaceMode:'isolated',verification:'independent',writePaths:['example.txt'],acceptanceEvidence:[{criterion,evidenceType:'native_check'}]});
    workspaces.prepare(target,producer,run,records.outputHeads(target));
    const producing=store.start(target,producer.config); history.bind(producing,run);
    store.recordSession(producing,randomUUID(),{fixture:'seeded producer submission'});
    fs.writeFileSync(path.join(target.workspace,'example.txt'),content);
    const artifacts=store.capture(target,'Submitted example',['example.txt']);
    target.artifactIds=artifacts.map(a=>a.id); target.candidateSnapshotId=history.snapshots.candidate(target.baseSnapshotId,artifacts,target.workspace);
    store.finishAttempt(team.id,producing.id,{status:'completed',text:'Prepared fixture.'},'runtime'); store.setStatus(target,'submitted');
    let steps=0,checkEvent;
    const review=service.runtime.requestReview(team.id,target.id,{clientRequestId:randomUUID(),expectedRevision:target.revision,
      reviewerMemberId:reviewer.id,instructions:'Execute an independent byte check.'});
    const latest=()=>store.get('works',team.id,review.id);
    respond=body=>{
      if (!body.tools?.some(t=>t.function.name==='teamswarm_team_review_command')) return 'No further action.';
      steps++;
      const result=JSON.stringify(body.messages.at(-1));
      if(steps===1) return {name:'teamswarm_team_read_artifacts',args:{artifactIds:target.artifactIds}};
      if(steps===2) { assert(result.includes(content)); return {name:'teamswarm_team_execution_environment',args:{}}; }
      if(steps===3) {
        const scratch=path.join(dataDir,'review-scratch',latest().attemptId);
        assert(result.includes(path.basename(scratch)));
        const check="const f=require('node:fs'),a=require('node:assert/strict');a.equal(f.readFileSync('example.txt','utf8'),process.argv[1]);"+
          "a.throws(()=>f.appendFileSync('example.txt','x'),e=>['EPERM','EACCES'].includes(e.code));f.writeFileSync(require('node:path').join(process.argv[2],'checked'),'ok');console.log('verified')";
        return {name:'teamswarm_team_review_command',args:{argv:[process.execPath,'-e', check + (replace ? ';setTimeout(()=>{},20000)' : ''),content,scratch]}};
      }
      if(steps===4) {
        checkEvent=store.events(team.id,0,10000).find(e=>e.attemptId===latest().attemptId && e.type==='execution.item' && e.data.reviewCommandLane);
        assert(checkEvent && result.includes(checkEvent.id) && result.includes('verified'),result);
        return {name:'teamswarm_team_accept_work',args:{workId:target.id,verdict:'accepted',criteria:[{criterion,passed:true,
          evidence:'The byte check passed.',evidenceType:'native_check',evidenceEventIds:[checkEvent.id]}]}};
      }
      assert.equal(steps,5); assert(result.includes('accepted'), result); return 'The independent byte check passed.';
    };
    const deadline=Date.now()+105000;
    if (replace) {
      while(!fixtureError && Date.now()<deadline && !fs.existsSync(path.join(dataDir,'review-scratch',latest().attemptId??'pending','checked'))) await sleep(50);
      if (fixtureError) throw fixtureError;
      const attemptId=latest().attemptId;
      assert(fs.existsSync(path.join(dataDir,'review-scratch',attemptId,'checked')));
      const replacement=service.runtime.continueWork(team.id,target.id,'Revise the submitted example.',randomUUID(),store.get('works',team.id,target.id).revision).work;
      const events=()=>store.events(team.id,0,10000).filter(e=>e.attemptId===attemptId);
      while(Date.now()<deadline && !(latest().status==='superseded' && events().some(e=>e.type==='review.command_runner_released'))) await sleep(75);
      assert.equal(latest().status,'superseded');
      const start=events().find(e=>e.type==='review.command_runner_started');
      assert(start && events().some(e=>e.type==='review.command_runner_released' && e.data.id===start.data.id));
      assert(!events().some(e=>e.type==='execution.item' && e.data.reviewCommandLane));
      assert(!store.list('acceptances',team.id).some(a=>[target.id,replacement.id].includes(a.workId)));
      assert(!fs.existsSync(path.join(project,'example.txt')));
      return {phase:'replacement',snapshot:target.candidateSnapshotId,replacement:replacement.id,reviewerAttemptId:attemptId,status:'superseded',receipts:0,commandReleased:true};
    }
    while(['queued','waiting','stopping','running'].includes(latest().status) && Date.now()<deadline && !fixtureError) await sleep(75);
    if(fixtureError) throw fixtureError;
    const work=latest(), attempt=work.attemptId && store.get('attempts',team.id,work.attemptId), published=store.get('works',team.id,target.id);
    assert.equal(attempt?.outcome?.status,'completed',JSON.stringify({status:work.status,error:work.error,outcome:attempt?.outcome}));
    assert.equal(published.publication?.state,'published',work.error); assert.equal(fs.readFileSync(path.join(project,'example.txt'),'utf8'),content);
    const acceptance=store.list('acceptances',team.id).find(a=>a.workId===target.id);
    assert.equal(acceptance.reviewerAttemptId,attempt.id); assert.equal(acceptance.reviewerMemberId,reviewer.id);
    assert.deepEqual(acceptance.artifactIds,target.artifactIds); assert.deepEqual(acceptance.criteria[0].evidenceEventIds,[checkEvent.id]);
    assert.equal(checkEvent.data.reviewEvidenceContext,attempt.reviewEvidenceContext); assert.equal(attempt.actual.detachedReviewCommands,true);
    return {phase:'publication',snapshot:target.candidateSnapshotId,reviewerAttemptId:attempt.id,event:checkEvent.id,acceptance:acceptance.id,publication:published.publication.state};
  } finally { await service.close(); }
}
try {
  const phases = process.argv.slice(2);
  for (const phase of phases.length ? phases : ['complete','replace','cancel','publication']) {
    assert(['complete','replace','cancel','publication'].includes(phase));
    console.log(JSON.stringify(phase === 'publication' || phase === 'replace' ? await runPublication(phase === 'replace') : await run(phase)));
  }
} finally {
  await harness.close(); await gateway.close(); globalThis.fetch=nativeFetch;
  upstream.closeAllConnections(); await new Promise(r=>upstream.close(r));
  fs.rmSync(directory,{recursive:true,force:true});
}
