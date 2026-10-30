import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { signInResultPage } from "../src/runtime/model-auth-page.js";

function page(options: { desktop?: boolean; opener?: boolean; complete?: boolean } = {}) {
  const timeouts = new Map<number, () => void>();
  const messages: any[] = [], requests: any[] = [], locations: string[] = [], histories: string[] = [];
  const handlers = new Map<string, (event: any) => void>();
  let closed = 0, next = 0;
  const opener = options.opener ? { closed: false, postMessage: (...args: any[]) => messages.push(args), focus() {} } : null;
  const elements = { "return-status": { textContent: "" }, return: { addEventListener: (_type: string, listener: any) => handlers.set("click", listener) } };
  const html = signInResultPage({ id: "login-fixture", receipt: "receipt-fixture", complete: options.complete !== false,
    presentation: { returnUrl: "http://127.0.0.1:4393/?view=models#/team/fixture", desktop: options.desktop } }).html;
  runInNewContext(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1], {
    URL, encodeURIComponent, window: { opener, close: () => closed++, addEventListener: (type: string, listener: any) => handlers.set(type, listener) },
    document: { getElementById: (id: keyof typeof elements) => elements[id] },
    history: { replaceState: (_state: any, _title: string, url: string) => histories.push(url) },
    location: { replace: (url: string) => locations.push(url) },
    fetch: async (...args: any[]) => { requests.push(args); return { ok: true }; },
    setTimeout: (fn: () => void) => { const id = ++next; timeouts.set(id, fn); return id; },
    clearTimeout: (id: number) => timeouts.delete(id),
  });
  return { messages, requests, locations, histories, handlers, opener, elements, get closed() { return closed; },
    async tick() { const tasks = [...timeouts.values()]; timeouts.clear(); for (const task of tasks) task(); await new Promise(setImmediate); } };
}

test("browser completion validates the acknowledgement and closes its popup", async () => {
  const view=page({opener:true});
  assert.deepEqual(view.histories,["/auth/result?receipt=receipt-fixture"]);
  await view.tick();
  assert.equal(view.messages[0][1],"http://127.0.0.1:4393");
  const data={type:"teamswarm:chatgpt-login-received",id:"login-fixture"};
  view.handlers.get("message")!({origin:"https://example.test",source:view.opener,data});assert.equal(view.closed,0);
  view.handlers.get("message")!({origin:"http://127.0.0.1:4393",source:{},data});assert.equal(view.closed,0);
  view.handlers.get("message")!({origin:"http://127.0.0.1:4393",source:view.opener,data});assert.equal(view.closed,1);
  await view.tick();assert.equal(view.locations.length,0);
});
test("missing or unresponsive opener returns to the same Team and relays the login identity",async()=>{
  for(const opener of [false,true]) {
    const view=page({opener});await view.tick();if(opener)await view.tick();
    const destination=new URL(view.locations[0]);assert.equal(destination.origin,"http://127.0.0.1:4393");
    assert.equal(destination.hash,"#/team/fixture");assert.equal(destination.searchParams.get("view"),"models");
    assert.equal(destination.searchParams.get("chatgpt_sign_in"),"login-fixture");
  }
});
test("desktop completion uses the callback event without navigating to a second web workspace",async()=>{
  const view=page({desktop:true});await view.tick();
  assert.equal(view.requests[0][0],"/auth/return?receipt=receipt-fixture");assert.equal(view.requests[0][1].method,"POST");
  assert.equal(view.locations.length,0);assert.match(view.elements["return-status"].textContent,/已返回 TeamSwarm/);
});
test("a failed sign-in waits for the return button",async()=>{
  const view=page({complete:false});await view.tick();assert.equal(view.locations.length,0);
  view.handlers.get("click")!({preventDefault(){}});assert.equal(view.locations.length,1);
});
