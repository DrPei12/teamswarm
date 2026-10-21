import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeConcurrency as analyze} from './analyzer.mjs';
const e = (type,workId='w',teamId='t',runId='r') => ({type,workId,teamId,runId});
const zero = {peakConcurrency:0,workTerminalStates:[],pauseResumeTransitions:0};
test('empty and nonarray',()=>{for(const x of [[],null,undefined,{}]) assert.deepEqual(analyze(x),zero);});
for(const state of ['submitted','accepted','failed','interrupted','yielded']) test(`${state} releases and preserves identity`,()=>{
  const result=analyze([e('work.running'),e(`work.${state}`),e('work.running','other')]);
  assert.equal(result.peakConcurrency,1);
  assert.deepEqual(result.workTerminalStates,[{teamId:'t',runId:'r',workId:'w',state}]);
});
test('later terminal and restart',()=>{
 const events=[e('work.submitted'),e('work.submitted'),e('work.accepted')];
 assert.deepEqual(analyze(events).workTerminalStates,[{teamId:'t',runId:'r',workId:'w',state:'accepted'}]);
 assert.deepEqual(analyze([...events,e('work.running')]).workTerminalStates,[]);
});
test('duplicate running even new attempt',()=>assert.equal(analyze([e('work.running'),{...e('work.running'),attemptId:'next'}]).peakConcurrency,1));
test('nonterminal occupation separate from latest lifecycle',()=>{
 for(const type of ['work.waiting','work.stopping','work.recovery_required','recovery_required']){
 assert.equal(analyze([e('work.running'),e(type),e('work.running','other')]).peakConcurrency,2);
 assert.deepEqual(analyze([e('work.failed'),e(type)]).workTerminalStates,[]);
 }
});
test('team run work identity',()=>{
 const ids=[['w','t','r'],['w','u','r'],['w','t','s'],['v','t','r']];
 const r=analyze([...ids.map(x=>e('work.running',...x)),...ids.map(x=>e('work.submitted',...x))]);
 assert.equal(r.peakConcurrency,4);assert.equal(r.workTerminalStates.length,4);
});
test('delimiter-like identity',()=>assert.equal(analyze([e('work.running','c','a|b','x'),e('work.running','b|c','a','x')]).peakConcurrency,2));
test('pause consumes once and repeat cycles',()=>assert.equal(analyze(['resumed','paused','paused','resumed','resumed','paused','resumed'].map(x=>e(`run.${x}`))).pauseResumeTransitions,2));
test('pause team run isolation',()=>{
 const events=[e('run.paused'),e('run.resumed','w','u'),e('run.resumed','w','t','s')];
 assert.equal(analyze(events).pauseResumeTransitions,0);
 assert.equal(analyze([...events,e('run.resumed')]).pauseResumeTransitions,1);
});
test('missing runs unmatched pause',()=>assert.equal(analyze([e('run.paused','w','t',null),e('run.resumed','w','t',null),e('run.paused')]).pauseResumeTransitions,0));
test('work yield wait never user pause',()=>assert.equal(analyze(['running','yielded','running','waiting','running'].map(x=>e(`work.${x}`))).pauseResumeTransitions,0));
test('unknown events ignored',()=>{
 assert.equal(analyze([e('work.running'),e('work.unknown'),e('work.running','other')]).peakConcurrency,2);
 assert.equal(analyze([e('work.failed'),e('work.unknown')]).workTerminalStates[0].state,'failed');
});

test('uncontracted lifecycle aliases are unknown and preserve current terminal',()=>{
 for(const type of ['work.created','work.queued','work.recovery-required']){
  assert.equal(analyze([e('work.failed'),e(type)]).workTerminalStates[0].state,'failed');
  assert.equal(analyze([e('work.running'),e(type),e('work.running','other')]).peakConcurrency,2);
 }
});
test('recovery aliases without work identity are ignored',()=>{
 for(const type of ['recovery_required','work.recovery_required']){
  assert.deepEqual(analyze([e(type,null)]),zero);
  assert.equal(analyze([e('work.submitted'),e(type,null)]).workTerminalStates[0].state,'submitted');
 }
});
test('missing work and optional identities',()=>{
 assert.deepEqual(analyze([e('work.running',null),e('work.submitted',null)]),zero);
 assert.deepEqual(analyze([{type:'work.failed',workId:'w'}]).workTerminalStates,[{teamId:null,runId:null,workId:'w',state:'failed'}]);
});
test('immutable input and team filtered independence',()=>{
 const input=Object.freeze([Object.freeze(e('work.running')),Object.freeze(e('work.running','w','u'))]);
 assert.equal(analyze(input).peakConcurrency,2);
 assert.equal(analyze(input.filter(x=>x.teamId==='t')).peakConcurrency,1);
 assert.deepEqual(analyze(input.filter(x=>x.teamId==='missing')),zero);
});
