// Run after npm run build. Set PLAYWRIGHT_EXECUTABLE_PATH for a system browser.
// Uses an isolated database, dynamic port, and no harness/model execution.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {chromium} from '../../teamswarm/node_modules/playwright/index.mjs';
import {createApp} from '../../apps/server/dist/app.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const data=mkdtempSync(path.join(root,'.test-offline-drafts-'));
const server=createServer().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const service=createApp({dataDir:data,apiPort:server.address().port,harnesses:[],webDistDir:path.join(root,'teamswarm/dist')});server.on('request',service.app);
let browser;
try{
 const origin=`http://127.0.0.1:${server.address().port}`;
 const call=async(route,body,method=body?'POST':'GET')=>{const r=await fetch(origin+'/api'+route,{method,headers:{Authorization:`Bearer ${service.controlToken}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert.ok(r.ok);return r.json()};
 const team=await call('/product/teams',{clientRequestId:crypto.randomUUID(),name:'Offline regression'});
 const chats=await Promise.all(['First','Second'].map(title=>call('/product/conversations',{clientRequestId:crypto.randomUUID(),teamId:team.id,title})));
 browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
 const context=await browser.newContext();await context.request.post(origin+'/api/control/session',{headers:{Authorization:`Bearer ${service.controlToken}`}});
 const pages=await Promise.all(chats.map(async chat=>{const page=await context.newPage();await page.goto(`${origin}/#/team/${team.id}/chat/${chat.id}`);await page.locator('textarea').waitFor();return page}));
 await new Promise(r=>setTimeout(r,700));await context.setOffline(true);
 const drafts=['离线甲需求：金额必须使用整数分','离线乙需求：保留原订单编号'];
 for(let i=0;i<pages.length;i++){await pages[i].locator('textarea').fill(drafts[i]);await new Promise(r=>setTimeout(r,500));}
 await Promise.all(pages.map(page=>page.close()));await context.setOffline(false);
 const restored=await context.newPage();await restored.goto(origin);await restored.locator('textarea').waitFor();
 let snapshot;for(let n=0;n<50;n++){snapshot=await call('/product');if(chats.every((chat,i)=>snapshot.drafts[chat.id]?.text===drafts[i]))break;await new Promise(r=>setTimeout(r,100));}
 for(let i=0;i<chats.length;i++)assert.equal(snapshot.drafts[chats[i].id]?.text,drafts[i]);
 console.log('PASS: both offline tabs survive closing and reopening with exact Chinese drafts');
}finally{await browser?.close();await service.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(data,{recursive:true,force:true});}
