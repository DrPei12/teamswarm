import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { generateKeyPair, SignJWT, jwtVerify } from "jose";
import { ChatGPTAccounts } from "../src/runtime/model-auth.js";

test("ChatGPT registration validates callback, PKCE, identity and encrypted refresh without Harness credentials",async()=>{
  const root=mkdtempSync(path.join(process.cwd(),".test-chatgpt-auth-"));
  const {privateKey,publicKey}=await generateKeyPair("RS256");
  let nonce="",refreshes=0,opens=0;
  const requests:URLSearchParams[]=[];
  const services={
    fetch:async(_url:any,init:any)=>{
      const body=new URLSearchParams(init.body);requests.push(body);
      assert.equal(body.get("client_id"),"oaiapp_fixture");assert.equal(body.get("resource"),"https://api.openai.com/v1");
      if(body.get("grant_type")==="refresh_token") {refreshes++;assert.equal(body.get("refresh_token"),"refresh-one");}
      const id=await new SignJWT({nonce,email:"fixture@example.test"}).setProtectedHeader({alg:"RS256"}).setIssuer("https://auth.openai.com").setAudience("oaiapp_fixture").setSubject("subject-one").setIssuedAt().setExpirationTime("1h").sign(privateKey);
      return Response.json({access_token:refreshes?"access-two":"access-one",refresh_token:refreshes?"refresh-two":"refresh-one",id_token:id,token_type:"Bearer",expires_in:refreshes?3600:1,scope:"openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"});
    },
    protect:async(value:string,decrypt=false)=>{if(decrypt)opens++;return decrypt?Buffer.from(value,"base64").toString():Buffer.from(value).toString("base64");},
    verify:async(token:string,client:string)=>(await jwtVerify(token,publicKey,{issuer:"https://auth.openai.com",audience:client,requiredClaims:["sub","exp","iat"]})).payload,
  };
  const auth=new ChatGPTAccounts(root,services);
  try{
    const start=await auth.start(), url=new URL(start.url);nonce=url.searchParams.get("nonce")!;
    assert.equal(url.searchParams.get("client_id"),"dynamic_agent_client");assert.equal(url.searchParams.get("agent_name_hint"),"TeamSwarm");
    assert.equal(url.searchParams.get("code_challenge_method"),"S256");assert.match(url.searchParams.get("ext_agent_host_id")!,/^urn:uuid:/);
    const callback=new URL(url.searchParams.get("redirect_uri")!);
    callback.search=new URLSearchParams({state:"wrong",code:"code-one",client_id:"oaiapp_fixture"}).toString();
    assert.equal((await fetch(callback)).status,400);assert.equal(requests.length,0);
    callback.searchParams.set("state",url.searchParams.get("state")!);
    assert.equal((await fetch(callback)).status,200);
    assert.equal(auth.status(start.id).state,"complete");assert.equal(requests[0].get("redirect_uri"),url.searchParams.get("redirect_uri"));
    assert.ok(requests[0].get("code_verifier"));
    const account=auth.list()[0];assert.equal(account.email,"fixture@example.test");
    const saved=readFileSync(path.join(root,"chatgpt-accounts.json"),"utf8");assert.ok(!saved.includes("refresh-one"));assert.ok(!saved.includes("access-one"));
    assert.ok(!("tokens" in account));
    const result=await Promise.all(Array.from({length:32},()=>auth.accessToken(account.id)));
    assert.deepEqual(new Set(result),new Set(["access-two"]));assert.equal(refreshes,1);assert.equal(opens,0);
    const next=await auth.start(account.id), nextURL=new URL(next.url);assert.equal(nextURL.searchParams.get("client_id"),"oaiapp_fixture");assert.equal(nextURL.searchParams.get("ext_agent_host_id"),url.searchParams.get("ext_agent_host_id"));
    const invalid=new URL(nextURL.searchParams.get("redirect_uri")!);invalid.search=new URLSearchParams({state:nextURL.searchParams.get("state")!,code:"code-two",client_id:"oaiapp_wrong"}).toString();
    assert.equal((await fetch(invalid)).status,400);assert.equal(auth.status(next.id).state,"failed");assert.equal(auth.list()[0].id,account.id);
  }finally{await auth.close();rmSync(root,{recursive:true,force:true});}
});

function deferred() {let resolve!:()=>void; const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}

test("signing in to an existing ChatGPT identity retains its connection ID", async () => {
  const root = mkdtempSync(path.join(process.cwd(), ".test-chatgpt-reuse-"));
  const auth = new ChatGPTAccounts(root, fixtureServices());
  try {
    const firstLogin = await callback(auth, "existing");
    assert.equal((await fetch(firstLogin.target)).status, 200);
    const first = auth.status(firstLogin.start.id).accountId!;
    const secondLogin = await callback(auth, "existing");
    assert.equal((await fetch(secondLogin.target)).status, 200);
    assert.equal(auth.status(secondLogin.start.id).accountId, first);
    assert.equal(auth.list().length, 1);
    assert.equal(auth.list()[0].id, first);
    assert.ok(await auth.accessToken(first));
  } finally { await auth.close(); rmSync(root, { recursive: true, force: true }); }
});

test("temporary ChatGPT refresh failures preserve authorization and can retry", async () => {
  const root = mkdtempSync(path.join(process.cwd(), ".test-chatgpt-retry-"));
  const services = fixtureServices(), original = services.fetch;
  let failure = 503;
  services.fetch = async (url, init) => {
    if (new URLSearchParams(init.body).get("grant_type") === "refresh_token" && failure)
      return Response.json({ error: failure === 400 ? "invalid_grant" : "server_error" }, { status: failure });
    return original(url, init);
  };
  const auth = new ChatGPTAccounts(root, services);
  try {
    const login = await callback(auth, "retry");
    assert.equal((await fetch(login.target)).status, 200);
    const id = auth.status(login.start.id).accountId!;
    await assert.rejects(auth.accessToken(id), /temporarily unavailable.*Try again/);
    assert.equal(auth.list()[0].connected, true);
    failure = 400;
    await assert.rejects(auth.accessToken(id), /authorization expired.*Reconnect/);
    failure = 0;
    assert.ok(await auth.accessToken(id));
    assert.equal(auth.list()[0].id, id);
  } finally { await auth.close(); rmSync(root, { recursive: true, force: true }); }
});
function fixtureServices(){
  let renew=0;
  const services={
    fetch:async(url:any,init:any)=>{
      if(String(url).includes("openid-configuration"))return Response.json({revocation_endpoint:"https://auth.openai.com/revoke"});
      if(String(url).endsWith("/revoke"))return new Response(null,{status:200});
      const body=new URLSearchParams(init.body),refresh=body.get("grant_type")==="refresh_token";
      if(refresh)renew++;
      return Response.json({access_token:"access-"+renew,refresh_token:"refresh-"+renew,expires_in:refresh?3600:1,scope:"chatgpt.tokens.use.direct",...(!refresh?{id_token:body.get("code")}: {})});
    },
    protect:async(value:string,decrypt=false)=>decrypt?Buffer.from(value,"base64").toString():Buffer.from(value).toString("base64"),
    verify:async(token:string)=>JSON.parse(token),
  };
  return services;
}
async function callback(auth:ChatGPTAccounts,subject:string,accountId?:string){
  const start=await auth.start(accountId),url=new URL(start.url),target=new URL(url.searchParams.get("redirect_uri")!);
  target.search=new URLSearchParams({state:url.searchParams.get("state")!,client_id:"oaiapp_fixture",code:JSON.stringify({sub:subject,nonce:url.searchParams.get("nonce"),email:subject+"@example.test"})}).toString();
  return {start,target};
}
test("two service instances retain both accounts and serialize refresh with sign-out",async()=>{
  const root=mkdtempSync(path.join(process.cwd(),".test-chatgpt-race-"));
  const services=fixtureServices(),first=new ChatGPTAccounts(root,services),second=new ChatGPTAccounts(root,services);
  try {
    const [a,b]=await Promise.all([callback(first,"first"),callback(second,"second")]);
    assert.deepEqual((await Promise.all([fetch(a.target),fetch(b.target)])).map(r=>r.status),[200,200]);
    assert.equal(first.list().length,2);
    const id=first.list().find(a=>a.subject==="first")!.id, started=deferred(),finish=deferred(),original=services.fetch;
    services.fetch=async(url,init)=>{if(new URLSearchParams(init?.body).get("grant_type")==="refresh_token"){started.resolve();await finish.promise;}return original(url,init);};
    const refreshing=first.accessToken(id);await started.promise;
    const signingOut=second.signOut(id);
    await assert.rejects(second.accessToken(id),/signing out/);
    finish.resolve();await refreshing;assert.equal((await signingOut).revoked,true);
    assert.equal(first.list().find(a=>a.id===id)!.connected,false);
    await assert.rejects(first.accessToken(id),/Continue with ChatGPT/);
  }finally{await Promise.all([first.close(),second.close()]);rmSync(root,{recursive:true,force:true});}
});

test("sign-out cancels an older login callback even after verification completes",async()=>{
  const root=mkdtempSync(path.join(process.cwd(),".test-chatgpt-logout-"));
  const services=fixtureServices(),auth=new ChatGPTAccounts(root,services);
  try {
    const initial=await callback(auth,"first");assert.equal((await fetch(initial.target)).status,200);
    const id=auth.list()[0].id, pending=await callback(auth,"first",id), entered=deferred(),finish=deferred();
    services.verify=async(token)=>{entered.resolve();await finish.promise;return JSON.parse(token);};
    const request=fetch(pending.target);await entered.promise;
    assert.equal((await auth.signOut(id)).revoked,true);finish.resolve();
    assert.equal((await request).status,400);assert.equal(auth.status(pending.start.id).state,"failed");
    assert.equal(auth.list()[0].connected,false);
  }finally{await auth.close();rmSync(root,{recursive:true,force:true});}
});

test("closing during listener startup rejects the login and closes the listener",async()=>{
  const root=mkdtempSync(path.join(process.cwd(),".test-chatgpt-close-")),auth=new ChatGPTAccounts(root,fixtureServices());
  try{const pending=auth.start();await auth.close();await assert.rejects(pending,/closing/);}finally{await auth.close();rmSync(root,{recursive:true,force:true});}
});

test("ChatGPT model choices use visible slugs and display names from the account catalog",async()=>{
  const root=mkdtempSync(path.join(process.cwd(),".test-chatgpt-models-")),services=fixtureServices();
  const original=services.fetch;
  services.fetch=async(url,init)=>String(url).endsWith("/models")?Response.json({models:[{slug:"gpt-fixture",display_name:"Fixture GPT",visibility:"list"},{slug:"hidden",visibility:"hide"},{slug:"gpt-fixture",visibility:"list"}]}):original(url,init);
  const auth=new ChatGPTAccounts(root,services);
  try{const start=await callback(auth,"fixture");assert.equal((await fetch(start.target)).status,200);assert.deepEqual(await auth.models(auth.list()[0].id),[{model:"gpt-fixture",name:"Fixture GPT"}]);}
  finally{await auth.close();rmSync(root,{recursive:true,force:true});}
});

test("cancelling sign-in closes its callback and allows a fresh attempt",async()=>{
  const root=mkdtempSync(path.join(process.cwd(),".test-chatgpt-cancel-")),auth=new ChatGPTAccounts(root,fixtureServices());
  try{const first=await auth.start();assert.equal(auth.cancel(first.id).state,"failed");const next=await auth.start();assert.notEqual(first.id,next.id);assert.equal(auth.status(next.id).state,"pending");}
  finally{await auth.close();rmSync(root,{recursive:true,force:true});}
});

test("the result page retains a safe receipt and returns the desktop window only from its own origin",async()=>{
  const root=mkdtempSync(path.join(process.cwd(),".test-chatgpt-return-")),auth=new ChatGPTAccounts(root,fixtureServices());
  const returned:string[]=[];
  try {
    await assert.rejects(auth.start(undefined,{returnUrl:"https://example.test/"}),/local TeamSwarm/);
    await assert.rejects(auth.start(undefined,{returnUrl:"http://user:password@localhost/"}),/local TeamSwarm/);
    const start=await auth.start(undefined,{returnUrl:"http://127.0.0.1:4393/#/team/fixture",language:"zh-CN",theme:"dark",desktop:true});
    const events:string[]=[];
    const unsubscribe=auth.watch(start.id,event=>{events.push(event);if(event==="return")returned.push(start.id);});
    const url=new URL(start.url), target=new URL(url.searchParams.get("redirect_uri")!);
    target.search=new URLSearchParams({state:url.searchParams.get("state")!,client_id:"oaiapp_fixture",code:JSON.stringify({sub:"return",nonce:url.searchParams.get("nonce"),email:"<fixture>@example.test"})}).toString();
    const response=await fetch(target), html=await response.text();
    assert.equal(response.status,200); assert.match(html,/ChatGPT 已连接/); assert.match(html,/返回 TeamSwarm/);
    assert.match(html,/&lt;fixture&gt;@example.test/); assert.match(html,/data-theme="dark"/);
    assert.equal(response.headers.get("cache-control"),"no-store"); assert.equal(response.headers.get("referrer-policy"),"no-referrer");
    assert.match(response.headers.get("content-security-policy")!,/frame-ancestors 'none'/);
    for (const secret of [url.searchParams.get("state")!,url.searchParams.get("nonce")!,"access-0","refresh-0"]) assert.ok(!html.includes(secret));
    const receipt=JSON.parse(html.match(/const c=(.*);const status=/)![1]).receipt;
    const resultURL=start.callbackOrigin+"/auth/result?receipt="+receipt;
    assert.equal((await fetch(resultURL)).status,200);
    assert.equal((await fetch(resultURL+"wrong")).status,404);
    const returnURL=start.callbackOrigin+"/auth/return?receipt="+receipt;
    assert.equal((await fetch(returnURL)).status,403);
    assert.equal((await fetch(returnURL,{method:"POST",headers:{Origin:"https://example.test"}})).status,403);
    assert.deepEqual(returned,[]);
    assert.equal((await fetch(returnURL,{method:"POST",headers:{Origin:start.callbackOrigin}})).status,204);
    assert.deepEqual(returned,[start.id]);
    const replay:string[]=[];const unwatch=auth.watch(start.id,event=>replay.push(event));
    assert.deepEqual(replay,["return"]);unwatch();
    assert.deepEqual(events,["state","state","return"]);
    assert.equal(auth.status(start.id).state,"complete");
    unsubscribe();await auth.close();assert.deepEqual(events,["state","state","return"]);
  } finally {await auth.close();rmSync(root,{recursive:true,force:true});}
});

test("declined sign-in has a result page and can return to the desktop without saving an account",async()=>{
  const root=mkdtempSync(path.join(process.cwd(),".test-chatgpt-decline-")),auth=new ChatGPTAccounts(root,fixtureServices());
  const events:string[]=[];
  try {
    const start=await auth.start(undefined,{returnUrl:"http://localhost:4393/",desktop:true}),url=new URL(start.url),target=new URL(url.searchParams.get("redirect_uri")!);
    auth.watch(start.id,event=>events.push(event));
    target.search=new URLSearchParams({state:url.searchParams.get("state")!,error:"access_denied"}).toString();
    const response=await fetch(target),html=await response.text();
    assert.equal(response.status,400);assert.match(html,/连接未完成/);assert.equal(auth.list().length,0);
    const receipt=JSON.parse(html.match(/const c=(.*);const status=/)![1]).receipt;
    assert.equal((await fetch(start.callbackOrigin+"/auth/return?receipt="+receipt,{method:"POST",headers:{Origin:start.callbackOrigin}})).status,204);
    assert.deepEqual(events,["state","state","return"]);
    await auth.close();assert.equal(events.at(-1),"close");
  } finally {await auth.close();rmSync(root,{recursive:true,force:true});}
});
