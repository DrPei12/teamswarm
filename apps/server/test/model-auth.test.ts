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
