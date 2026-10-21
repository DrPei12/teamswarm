import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseEvents } from './parser.mjs';
// All fixtures are static: static parser fixtures.
const fixture = name => fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
const parse = name => parseEvents(fixture(name));
test('valid disorder sorts and returns public shape', async () => {
 const r=await parse('valid');
 assert.deepEqual(Object.keys(r).sort(),['events','warnings']);
 assert.deepEqual(r.events.map(e=>e.id),['a','b','c']);
 assert.deepEqual(r.warnings,[]);
});
test('empty array yields empty results',async()=>assert.deepEqual(await parse('empty-array'),{events:[],warnings:[]}));
for(const [name,pattern] of [
 ['empty',/Empty file/],['whitespace',/Empty file/],['invalid-json',/Invalid JSON/],['non-array',/Expected JSON array/],
 ...['sequence','id','type'].map(f=>[`missing-${f}`,new RegExp(`missing required field: ${f}`)]),
 ...['zero','negative','fraction','string'].map(p=>[`${p}-sequence`,/invalid sequence/]),
 ['invalid-id',/invalid id/],['invalid-type',/invalid type/],
 ...['null','array','primitive'].map(p=>[`${p}-event`,/index 0 is not an object/]),
 ['conflict',/Conflicting duplicate event id: conflict/]
]) test(`rejects ${name} descriptively`,async()=>assert.rejects(()=>parse(name),pattern));
test('missing filesystem path propagates ENOENT',async()=>assert.rejects(()=>parse('intentionally-not-present'),{code:'ENOENT'}));
test('identical replay deduplicates silently',async()=>{
 const r=await parse('replay'); assert.deepEqual(r.events.map(e=>e.id),['a','b']); assert.deepEqual(r.warnings,[]);
});
test('distinct ids sharing cursor survive',async()=>assert.deepEqual((await parse('same-cursor')).events.map(e=>e.id),['a','b']));
test('run events known and sorted',async()=>{
 const r=await parse('run-events'); assert.deepEqual(r.events.map(e=>e.type),['run.paused','run.resumed']); assert.deepEqual(r.warnings,[]);
});
test('all known types',async()=>{
 const r=await parse('all-known'); assert.equal(r.events.length,16); assert.deepEqual(r.warnings,[]);
});
test('headers remain distinct from reads and payloads preserved',async()=>{
 const r=await parse('headers-reads'); assert.deepEqual(r.events.map(e=>e.type),['exchange.headers_delivered','exchange.read']);
 assert.deepEqual(r.events.map(e=>e.data.messageIds),[['m'],['m','n']]); assert.deepEqual(r.warnings,[]);
});
test('unknown events preserved; unique warnings global not team filtered',async()=>{
 const r=await parse('unknown'); assert.equal(r.events.length,3);
 assert.deepEqual(r.warnings,['Unknown event type: future.a','Unknown event type: future.b']);
 assert.deepEqual([...new Set(r.events.filter(e=>e.teamId==='chosen').map(e=>e.type))],['future.a']);
});
test('synthetic sample unchanged and lossless',async()=>{
 const original=await readFile(new URL('../../sample-events.json',import.meta.url),'utf8');
 assert.equal(await readFile(fixture('sample-events'),'utf8'),original);
 const input=JSON.parse(original); const r=await parse('sample-events');
 assert.equal(r.events.length,input.length); assert.ok(input.length>40);
 assert.deepEqual(r.events,input.toSorted((a,b)=>a.sequence-b.sequence)); assert.deepEqual(r.warnings,[]);
});
