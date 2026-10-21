import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loginPrompt, grokModels, SubscriptionAccounts, subscriptionInspection, subscriptionEnvironment, subscriptionScope } from "../src/runtime/harness/subscriptions.js";
import { checkExecutionCompatibility } from "../src/runtime/allocation-contract.js";

const claudeURL = "https://claude.com/cai/oauth/authorize?response_type=code&state=fixture&code_challenge=fixture&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback";
test("official login links are validated before being exposed to the UI", () => {
  assert.equal(loginPrompt("claude-code", claudeURL)?.url, claudeURL);
  assert.equal(loginPrompt("claude-code", claudeURL.replace("claude.com", "claude.com.evil.test")), null);
  assert.equal(loginPrompt("claude-code", claudeURL.replace("response_type=code", "response_type=token")), null);
  assert.equal(loginPrompt("grok", "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234\nConfirm this code in your browser: ABCD-1234")?.code, "ABCD-1234");
  assert.equal(loginPrompt("grok", "To sign in, open this URL:\nhttps://accounts.x.ai/oauth2/device?user_code=ABCD-1234")?.code, "ABCD-1234");
  assert.equal(loginPrompt("grok", "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234&user_code=EFGH-5678"), null);
  assert.equal(loginPrompt("grok", "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234\nConfirm this code in your browser: EFGH-5678"), null);
  assert.equal(loginPrompt("grok", "https://accounts.x.ai.evil.test/oauth2/device?user_code=ABCD-1234\nConfirm this code in your browser: ABCD-1234"), null);
  assert.equal(grokModels("You are not authenticated.\n* grok-4.6 (default)\n- grok-4.5").length, 2);
});

test("Grok device login and model verification require an authenticated, complete response", { timeout: 20000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-grok-subscription-test-"));
  const previousHome = process.env.TEAM_ACCOUNT_HOME, previousBin = process.env.TEAM_GROK_BIN;
  process.env.TEAM_ACCOUNT_HOME = root;
  const entry = path.join(root, "grok-fixture.mjs");
  process.env.TEAM_GROK_BIN = entry;
  writeFileSync(entry, `
    import fs from 'node:fs'; import path from 'node:path';
    const args=process.argv.slice(2), home=process.env.GROK_HOME;
    const flag=name=>fs.existsSync(path.join(home,name));
    const log=value=>console.log(JSON.stringify(value));
    if(args[0]==='models') console.log((flag('auth.json')?'':'You are not authenticated.\\n')+'* grok-4.6 (default)');
    else if(args[0]==='login') {
      console.log('To sign in, open this URL: https://accounts.x.ai/oauth2/device?user_code=ABCD-1234');
      setInterval(()=>{ if(flag('permit')) {fs.writeFileSync(path.join(home,'auth.json'),JSON.stringify({grok:{key:'fixture',refresh_token:'fixture'}}));process.exit(0)} },20);
    } else if(args[0]==='--single') {
      if(!flag('empty')) log({type:'text',data:'OK'});
      log({type:'end',stopReason:flag('partial')?'max_turns':'end_turn'});
    }
  `);
  const accounts = new SubscriptionAccounts(), home = path.join(root, "grok");
  const waitFor = async (predicate: () => boolean) => { for(let n=0;n<150;n++){if(predicate())return;await new Promise(r=>setTimeout(r,20));}throw new Error("Grok fixture login timed out"); };
  try {
    const before = await accounts.status("grok", "grok-4.6");
    assert.equal(before.authenticated, false); assert.equal(before.models.length, 1);
    await accounts.start("grok");
    await waitFor(()=>accounts.login("grok")?.state==='waiting');
    await accounts.close("claude-code");
    assert.equal(accounts.login("grok")?.state, "waiting");
    await assert.rejects(accounts.checkModel("grok", "grok-4.6"), /sign-in/);
    writeFileSync(path.join(home, "permit"), "1");
    await waitFor(()=>accounts.login("grok")?.state==='complete');
    assert.equal((await accounts.status("grok", "grok-4.6")).modelCheck.state, "not_checked");
    assert.equal((await accounts.checkModel("grok", "grok-4.6")).state, "available");
    writeFileSync(path.join(home, "partial"), "1");
    assert.equal((await accounts.checkModel("grok", "grok-4.6")).state, "unavailable");
    rmSync(path.join(home, "partial")); writeFileSync(path.join(home, "empty"), "1");
    assert.equal((await accounts.checkModel("grok", "grok-4.6")).state, "unavailable");
  } finally {
    await accounts.close();
    if(previousHome === undefined) delete process.env.TEAM_ACCOUNT_HOME; else process.env.TEAM_ACCOUNT_HOME = previousHome;
    if(previousBin === undefined) delete process.env.TEAM_GROK_BIN; else process.env.TEAM_GROK_BIN = previousBin;
    rmSync(root, { recursive:true, force:true });
  }
});

test("subscription config is independent of an API connection and enforces native protocol", () => {
  const config = { harness: "claude-code", model: null, provider: null, baseUrl: null, credentialEnv: null, effort: "high", access: "read-only" as const, protocol: null, thinkingFormat: null };
  assert.deepEqual(checkExecutionCompatibility(config), []);
  assert.deepEqual(checkExecutionCompatibility({ ...config, harness: "grok", effort: null }), []);
  assert.ok(checkExecutionCompatibility({ ...config, harness: "grok" }).includes("unsupported_effort"));
  assert.ok(checkExecutionCompatibility({ ...config, baseUrl: "https://example.test" }).includes("missing_configuration"));
  assert.ok(checkExecutionCompatibility({ ...config, protocol: "responses" }).includes("incompatible_protocol"));
});

test("login cancellation, account switching, native catalog and model checks remain distinct", { timeout: 30000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-subscription-test-"));
  const vars = ["TEAM_ACCOUNT_HOME", "TEAM_CLAUDE_CODE_BIN", "TEAM_GROK_BIN", "ANTHROPIC_API_KEY", "XAI_API_KEY"];
  const previous = vars.map(key => process.env[key]);
  process.env.TEAM_ACCOUNT_HOME = root;
  process.env.ANTHROPIC_API_KEY = "fixture-secret";
  process.env.XAI_API_KEY = "fixture-secret";
  const entry = path.join(root, "fixture.mjs");
  writeFileSync(entry, `
    import fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline';
    const args=process.argv.slice(2), home=process.env.CLAUDE_CONFIG_DIR || process.env.GROK_HOME;
    const flag=name=>fs.existsSync(path.join(home,name));
    const log=value=>console.log(JSON.stringify(value));
    fs.appendFileSync(path.join(home,'calls.jsonl'),JSON.stringify(args)+'\\n');
    if(args[0]==='auth' && args[1]==='status') {
      if(flag('delay')) await new Promise(r=>setTimeout(r,350));
      log({loggedIn:flag('signed'),authMethod:flag('signed')?'claude.ai':'none',email:'fixture@example.test'});
    } else if(args[0]==='auth' && args[1]==='login') {
      console.log(${JSON.stringify(claudeURL)});
      process.stdin.once('data',()=>{fs.writeFileSync(path.join(home,'signed'),'1');fs.writeFileSync(path.join(home,'.credentials.json'),'fixture');process.exit(0)});
    } else if(args[0]==='models') {
      console.log('You are not authenticated.\\n* grok-4.6 (default)');
    } else if(args.includes('--input-format')) {
      readline.createInterface({input:process.stdin}).once('line',()=>{log({type:'control_response',response:{request_id:'catalog',response:{models:[{value:'sonnet',displayName:'Sonnet',supportedEffortLevels:['low','high']}]}}});});
    } else if(args.includes('--print')) {
      if(flag('quota')) {log({type:'result',is_error:true,error:'quota limit'});process.exitCode=1;}
      else log({type:'result',is_error:false,result:'OK'});
    }
  `);
  process.env.TEAM_CLAUDE_CODE_BIN = entry; process.env.TEAM_GROK_BIN = entry;
  const accounts = new SubscriptionAccounts();
  const waitFor = async (predicate: () => boolean) => { for (let n=0;n<100;n++) { if(predicate()) return; await new Promise(r=>setTimeout(r,30)); } throw new Error("Timed out waiting for fixture login"); };
  try {
    assert.equal(subscriptionEnvironment("claude-code").ANTHROPIC_API_KEY, undefined);
    assert.equal(subscriptionEnvironment("grok").XAI_API_KEY, undefined);
    const unsigned = await subscriptionInspection("claude-code");
    assert.equal(unsigned.installed, true); assert.equal(unsigned.authenticated, false);
    assert.equal(unsigned.models[0].model, "sonnet");
    await assert.rejects(accounts.checkModel("claude-code", "sonnet"), /Sign in/);
    const grok = await subscriptionInspection("grok");
    assert.equal(grok.models.length, 1); assert.equal(grok.authenticated, false);
    const scope = subscriptionScope("claude-code");
    const first = (await accounts.start("claude-code"))!;
    assert.notEqual(scope, subscriptionScope("claude-code"));
    await waitFor(()=>accounts.login("claude-code")?.state === "waiting");
    const cancelled = await accounts.cancel("claude-code", first.id);
    assert.equal(cancelled?.state, "cancelled"); assert.equal(cancelled?.url, undefined);
    const second = (await accounts.start("claude-code"))!;
    await waitFor(()=>accounts.login("claude-code")?.state === "waiting");
    accounts.submitCode("claude-code", second.id, "fixture-code");
    await waitFor(()=>accounts.login("claude-code")?.state === "complete");
    assert.equal(accounts.login("claude-code")?.url, undefined);
    const status = await accounts.status("claude-code", "sonnet");
    assert.equal(status.authenticated, true); assert.equal(status.modelCheck.state, "not_checked");
    assert.equal((await accounts.checkModel("claude-code", "sonnet")).state, "available");
    assert.equal((await accounts.status("claude-code", "haiku")).modelCheck.state, "not_checked");
    const home = path.join(root, "claude-code");
    writeFileSync(path.join(home, "quota"), "1");
    const limited = await accounts.checkModel("claude-code", "sonnet");
    assert.equal(limited.state, "unavailable"); assert.match(limited.error!, /quota/);
    writeFileSync(path.join(home, "delay"), "1");
    const third = (await accounts.start("claude-code"))!;
    await waitFor(()=>accounts.login("claude-code")?.state === "waiting");
    accounts.submitCode("claude-code", third.id, "fixture-code");
    await new Promise(r=>setTimeout(r,70));
    await accounts.cancel("claude-code", third.id);
    await new Promise(r=>setTimeout(r,700));
    assert.equal(accounts.login("claude-code")?.state, "cancelled");
    const calls = readFileSync(path.join(home, "calls.jsonl"), "utf8");
    assert.ok(calls.includes('--claudeai')); assert.ok(!calls.includes('--bare'));
    assert.ok(!JSON.stringify(status).includes('fixture-secret'));
  } finally {
    await accounts.close();
    vars.forEach((key,i)=>{ if(previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    rmSync(root, { recursive:true, force:true });
  }
});
