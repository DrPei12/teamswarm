import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {createServer} from "node:http";
import {chromium} from "../../teamswarm/node_modules/playwright/index.mjs";
import {createApp} from "../../apps/server/dist/app.js";

fs.mkdirSync(path.resolve(".local/verification"), {recursive:true});
const root=fs.mkdtempSync(path.resolve(".local/verification/conversation-ui-"));
const project=path.join(root,"project");
fs.mkdirSync(project);
process.env.TEAM_PROJECTS_DIR=path.join(root,"projects");
const fixture = { id:"codex",capabilities:{fixture:true},async inspect(){return {installed:true,available:true}},
  permissionOptions(){return {defaultId:"manual",options:[]}}, validateConfig(){},
  async execute(request){
    request.onSession(randomUUID());request.onTurn(randomUUID());
    const input=JSON.parse(request.input);
    return {status:"completed",text:"Reply: "+String(input.current?.request?.content ?? input.current?.userRequest ?? request.input.match(/ORIGINAL_ONE|ORIGINAL_TWO|REVISED_TWO|SIDE_REQUEST/)?.[0] ?? "fixture")};
  },async close(){},async interrupt(){} };
const server=createServer();
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const service=createApp({dataDir:path.join(root,"data"),apiPort:server.address().port,harnesses:[fixture],webDistDir:path.resolve("teamswarm/dist")});
server.on("request",service.app);
const origin="http://127.0.0.1:"+server.address().port;
const call=async (url,body,method=body?"POST":"GET") => {
  const response=await fetch(origin+"/api"+url,{method,headers:{"content-type":"application/json",authorization:"Bearer "+service.controlToken},body:body&&JSON.stringify(body)});
  assert(response.ok,await response.clone().text());return response.json();
};
let browser;
try {
 const team=await call("/product/teams",{name:"Workspace Branch Test",workspace:project,clientRequestId:randomUUID()});
 const conversation = () => call("/product");
 const send=async(content)=>await call("/product/messages",{clientRequestId:randomUUID(),teamId:team.id,conversationId:team.mainChatId,content});
 for(const input of ["ORIGINAL_ONE","ORIGINAL_TWO"]) {
  const {workId}=await send(input);
  const done=Date.now()+10000;
  while(service.runtime.store.get("works",team.id,workId).status!=="submitted"){
    assert(Date.now()<done,"Host did not finish");
    await new Promise(r=>setTimeout(r,50));
  }
 }
 const seeded=(await conversation()).chats.find(c=>c.id===team.mainChatId);
 assert.equal(seeded.messages.length,4);
 const options={headless:true};
 if(process.env.PLAYWRIGHT_EXECUTABLE_PATH)options.executablePath=process.env.PLAYWRIGHT_EXECUTABLE_PATH;
 else if(process.env.TEAMSWARM_BROWSER_CHANNEL)options.channel=process.env.TEAMSWARM_BROWSER_CHANNEL;
 browser=await chromium.launch(options);
 const context=await browser.newContext({viewport:{width:1400,height:900}});
 await context.request.post(origin+"/api/control/session",{headers:{authorization:"Bearer "+service.controlToken}});
 const page=await context.newPage();
 page.setDefaultTimeout(10000);
 const errors=[];page.on("pageerror",e=>errors.push(e.message));
 await page.goto(origin+"/#/team/"+team.id+"/chat/"+team.mainChatId);
 await page.locator(".composer-workspace").getByText(path.basename(project),{exact:true}).waitFor();
 const firstReply=page.locator(".message-host").first();
 await firstReply.getByRole("button",{name:"Message actions"}).click();
 await page.getByRole("menuitem",{name:"Branch to new chat"}).click();
 await page.waitForURL(url=>!url.hash.endsWith(team.mainChatId));
 let state=await conversation();
 let branch=state.chats.find(c=>c.id===page.url().split("/").at(-1));
 assert.equal(branch.kind,"branch");
 assert.deepEqual(branch.messages.map(m=>m.text),seeded.messages.slice(0,2).map(m=>m.text));
 assert.equal(branch.parent.chatId,team.mainChatId);
 assert.equal(branch.workspace,project);
 assert.equal(state.executions[team.id].host.config.access,"read-only");
 await page.getByRole("button",{name:"Toggle Host branches"}).click();
 await page.locator(".activity-disclosure[aria-hidden=true]").filter({has:page.locator(".host-branches")}).waitFor({state:"attached"});
 await page.getByRole("button",{name:"Toggle Host branches"}).click();
 await page.locator(".host-branch-link").first().waitFor();
 await page.locator(".host-branch-row").filter({has:page.getByRole("button",{name:"Branch options"})}).first().getByRole("button",{name:"Branch options"}).click();
 await page.getByRole("menuitem",{name:"Delete chat"}).click();
 await page.getByRole("dialog",{name:"Delete chat"}).getByRole("button",{name:"Delete chat",exact:true}).click();
 await page.waitForURL(url=>url.hash.endsWith(team.mainChatId));
 assert((await conversation()).chats.find(c=>c.id===branch.id).archived);
 await page.getByRole("button",{name:"Side chats",exact:true}).click();
 await page.getByRole("button",{name:"New side chat"}).click();
 const aside=page.getByRole("complementary",{name:"Side chats"});
 await aside.getByRole("textbox",{name:"Side chat",exact:true}).fill("SIDE_REQUEST");
 await aside.getByRole("button",{name:"Send message"}).click();
 await aside.locator(".side-chat-messages").getByText("SIDE_REQUEST",{exact:true}).waitFor();
 assert(page.url().endsWith(team.mainChatId));
 await aside.getByRole("button",{name:"Close",exact:true}).click();
 const user=page.locator(".message-user").filter({hasText:"ORIGINAL_TWO"});
 await user.getByRole("button",{name:"Edit message", exact:true}).click();
 await user.getByRole("textbox",{name:"Edit message"}).fill("REVISED_TWO");
 await user.getByRole("button",{name:"Send revised message"}).click();
 await page.waitForURL(url=>!url.hash.endsWith(team.mainChatId));
 state=await conversation();
 branch=state.chats.find(c=>c.id===page.url().split("/").at(-1));
 assert(branch.messages.some(m=>m.text==="REVISED_TWO"));
 assert(!branch.messages.some(m=>m.text==="ORIGINAL_TWO"));
 assert.equal(state.chats.find(c=>c.id===team.mainChatId).messages.length,4);
 await page.locator(".sidebar-primary").getByRole("button",{name:"New chat",exact:true}).click();
 await page.waitForURL(url=>!url.hash.includes(team.id));
 state=await conversation();
 const independent=state.chats.find(c=>c.kind==="independent");
 assert(independent && independent.teamId!==team.id && !independent.parent);
 await page.locator(".composer-workspace").waitFor();
 await page.getByRole("button",{name:"Choose project",exact:true}).waitFor();
 const independentId=independent.id;
 const chosen=path.join(root,"selected-project");fs.mkdirSync(chosen);
 await page.getByRole("button",{name:"Choose project",exact:true}).click();
 const folderDialog=page.getByRole("dialog",{name:"Project folder",exact:true});
 await folderDialog.getByRole("textbox",{name:"Project folder",exact:true}).fill(chosen);
 await folderDialog.getByRole("button",{name:"Save",exact:true}).click();
 await page.getByRole("button",{name:"Change project folder",exact:true}).getByText("selected-project",{exact:true}).waitFor();
 state=await conversation();
 assert.equal(state.chats.find(c=>c.id===independentId).workspace,chosen);
 assert.equal(state.teams.find(t=>t.id===independent.teamId).independent,false);
 const changed=path.join(root,"another-project");fs.mkdirSync(changed);
 await page.getByRole("button",{name:"Change project folder",exact:true}).click();
 await folderDialog.getByRole("textbox",{name:"Project folder",exact:true}).fill(changed);
 await folderDialog.getByRole("button",{name:"Save",exact:true}).click();
 await page.getByRole("button",{name:"Change project folder",exact:true}).getByText("another-project",{exact:true}).waitFor();
 await page.reload();
 await page.getByRole("button",{name:"Change project folder",exact:true}).getByText("another-project",{exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 await page.screenshot({path:path.join(root,"independent-chat.png")});
 console.log(JSON.stringify({root,workspace:true,cutoff:true,branchDeletion:true,sidePanel:true,edit:true,independent:true}));
} finally {
 await browser?.close();
 server.closeAllConnections();
 await service.close();
 await new Promise(r=>server.close(r));
}
