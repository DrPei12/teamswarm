import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PreferencesOutbox} from '../teamswarm/src/preferences-outbox.ts';
function storage(){const values=new Map();return {get length(){return values.size},key:i=>[...values.keys()][i]??null,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)}}
test('independent offline tabs retain both Chinese conversation drafts on reopening',()=>{
 const shared=storage(),a=new PreferencesOutbox(shared),b=new PreferencesOutbox(shared);
 a.append({drafts:{alpha:{text:'金额必须使用整数分',files:[]}}});
 b.append({drafts:{beta:{text:'保留原订单编号',files:[]}}});
 assert.deepEqual(new PreferencesOutbox(shared).snapshot().patch.drafts,{alpha:{text:'金额必须使用整数分',files:[]},beta:{text:'保留原订单编号',files:[]}});
});
test('acknowledging an in-flight batch cannot remove another tab or newer edits',()=>{
 const shared=storage(),a=new PreferencesOutbox(shared),b=new PreferencesOutbox(shared);
 a.append({drafts:{alpha:{text:'old',files:[]}}});const sent=a.snapshot();
 b.append({drafts:{beta:{text:'other tab',files:[]}}});a.append({drafts:{alpha:{text:'new',files:[]}}});
 a.acknowledge(sent.entries);const pending=b.snapshot();
 assert.equal(pending.patch.drafts.alpha.text,'new');assert.equal(pending.patch.drafts.beta.text,'other tab');
 b.acknowledge(pending.entries);assert.deepEqual(a.snapshot().patch,{});
});
test('legacy pending data merges with new journal entries and remains until acknowledged',()=>{
 const shared=storage();shared.setItem('teamswarm.preferences.pending',JSON.stringify({drafts:{legacy:{text:'未保存草稿',files:[]}},language:'en'}));
 const outbox=new PreferencesOutbox(shared);outbox.append({language:'zh-CN',theme:'dark'});
 const saved=outbox.snapshot();assert.equal(saved.patch.language,'zh-CN');assert.equal(saved.patch.drafts.legacy.text,'未保存草稿');
 assert.deepEqual(new PreferencesOutbox(shared).snapshot().patch,saved.patch);outbox.acknowledge(saved.entries);assert.equal(shared.length,0);
});
test('ordered edits preserve deletion and merge independent nested chat fields',()=>{
 const outbox=new PreferencesOutbox(storage());outbox.append({drafts:{chat:{text:'first',files:[]}},chats:{chat:{starred:true}}});outbox.append({drafts:{chat:null},chats:{chat:{title:'最新需求'}}});
 assert.deepEqual(outbox.snapshot().patch,{drafts:{chat:null},chats:{chat:{starred:true,title:'最新需求'}}});
});
test('desktop key-value bridge retains newer edits while an earlier batch is acknowledged',()=>{
 const shared=storage(),bridge={getItem:shared.getItem,setItem:shared.setItem,removeItem:shared.removeItem};const outbox=new PreferencesOutbox(bridge);
 outbox.append({name:'old'});const sent=outbox.snapshot();outbox.append({name:'new'});outbox.acknowledge(sent.entries);assert.equal(outbox.snapshot().patch.name,'new');
});
test('different fields of the same chat coexist and repeated draft edits stay bounded',()=>{
 const shared=storage(),a=new PreferencesOutbox(shared),b=new PreferencesOutbox(shared);
 a.append({chats:{chat:{starred:true}}});b.append({chats:{chat:{title:'变更后的标题'}}});
 for(let i=0;i<2000;i++) a.append({drafts:{chat:{text:'中文内容'.repeat(100)+i,files:[]}}});
 assert.equal(shared.length,3);assert.deepEqual(a.snapshot().patch.chats.chat,{starred:true,title:'变更后的标题'});assert.ok(a.snapshot().patch.drafts.chat.text.endsWith('1999'));
});
test('a cross-tab edit between receipt comparison and removal cannot be deleted',()=>{
 const shared=storage(),a=new PreferencesOutbox(shared),b=new PreferencesOutbox(shared);
 a.append({drafts:{chat:{text:'sent',files:[]}}});const sent=a.snapshot();
 const get=shared.getItem;let injected=false;
 shared.getItem=key=>{const value=get(key);if(!injected&&key===sent.entries[0].key){injected=true;b.append({drafts:{chat:{text:'new concurrent edit',files:[]}}});}return value;};
 a.acknowledge(sent.entries);assert.equal(b.snapshot().patch.drafts.chat.text,'new concurrent edit');
});
