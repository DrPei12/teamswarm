import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

test('desktop member creation persists its retry identity and rejects unrelated storage or origins',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'teamswarm-member-ipc-'));
 const main=fileURLToPath(new URL('../apps/desktop/main.cjs',import.meta.url)),require=createRequire(main),handlers=new Map();
 const electron={app:{isPackaged:false,setName(){},setAppUserModelId(){},setPath(){},getPath:()=>root,getLocale:()=> 'en',requestSingleInstanceLock:()=>false,quit(){}},ipcMain:{on:(name,fn)=>handlers.set(name,fn),handle(){}},session:{}};
 const context=vm.createContext({require:id=>id==='electron'?electron:require(id),__dirname:path.dirname(main),process:{env:{TEAMSWARM_USER_DATA:root},platform:process.platform},setTimeout,clearTimeout,setInterval,clearInterval,Buffer,URL,console});
 try{
  vm.runInContext(readFileSync(main,'utf8')+'\norigin="http://127.0.0.1:4390";mainWindow={webContents:{}};globalThis.testSender=mainWindow.webContents;',context);
  const invoke=(action,key,value,url='http://127.0.0.1:4390/')=>{const event={sender:context.testSender,senderFrame:{url}};handlers.get('pending-input')(event,action,key,value);return event.returnValue;};
  const key='teamswarm.member-create:11111111-1111-4111-8111-111111111111',value=JSON.stringify({signature:'fixture',clientRequestId:'retry-identity'});
  assert.equal(invoke('get',key).value,null);assert.equal(invoke('set',key,value).error,undefined);assert.equal(invoke('get',key).value,value);
  assert.equal(JSON.parse(readFileSync(path.join(root,'pending-input.json'),'utf8'))[key],value);
  assert.equal(invoke('remove',key).error,undefined);assert.equal(invoke('get',key).value,null);
  for(const denied of ['teamswarm.member-create:invalid',key+'/suffix','credentials'])assert.match(invoke('set',denied,value).error,/Untrusted/);
  assert.match(invoke('set',key,value,'https://outside.example/').error,/Untrusted/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
