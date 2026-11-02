import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeTranscript } from "../src/runtime/harness/native-transcript.js";

for (const harness of ["deepseek-harness", "claude-code", "pi"]) {
  test(`${harness} exposes public text before completion, tool lifecycle and no reasoning content`, () => {
    const events: any[] = [];
    const observer = new NativeTranscript(harness, "turn", (type,data) => events.push({type,data}));
    assert.equal(events[0].data.status, "running");
    if (harness === "deepseek-harness") {
      observer.observe({method:"teamswarm.transcript",params:{id:"step",type:"text",text:"Public "}});
      assert(events.some(e => e.type === "transcript.delta" && e.data.delta === "Public "));
      observer.observe({method:"session.event",params:{event:{type:"assistant/message",data:{message:{id:"m",content:[{type:"text",text:"Public progress"},{type:"reasoning",text:"PRIVATE_REASONING"},{type:"tool-call",id:"call",name:"mcp__teamswarm__team_state"}]}}}}});
      observer.observe({method:"session.event",params:{event:{type:"tool/call",data:{callId:"call",name:"mcp__teamswarm__team_state",arguments:{}}}}});
      observer.observe({method:"session.event",params:{event:{type:"tool/result",data:{message:{toolCallId:"call",content:[{type:"text",text:"actual result"}],isError:false}}}}});
    } else if (harness === "claude-code") {
      observer.observe({type:"stream_event",event:{type:"message_start",message:{id:"m"}}});
      observer.observe({type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text:"Public "}}});
      assert(events.some(e => e.type === "transcript.delta"));
      observer.observe({type:"stream_event",event:{type:"content_block_delta",delta:{type:"thinking_delta",thinking:"PRIVATE_REASONING"}}});
      observer.observe({type:"assistant",message:{id:"m",content:[{type:"text",text:"Public progress"},{type:"tool_use",id:"call",name:"mcp__teamswarm__team_state",input:{}}]}});
      observer.observe({type:"user",message:{content:[{type:"tool_result",tool_use_id:"call",content:"actual result"}]}});
    } else {
      observer.observe({type:"pi.message.delta",sequence:1,delta:"Public "});
      assert(events.some(e => e.type === "transcript.delta"));
      observer.observe({type:"pi.event",sequence:1,event:{type:"message_end",message:{role:"assistant",content:[{type:"text",text:"Public progress"},{type:"thinking",thinking:"PRIVATE_REASONING"},{type:"toolCall",id:"call",name:"team_state"}]}}});
      observer.observe({type:"pi.event",event:{type:"tool_execution_start",toolCallId:"call",toolName:"team_state",args:{}}});
      observer.observe({type:"pi.event",event:{type:"tool_execution_end",toolCallId:"call",result:{content:[{type:"text",text:"actual result"}]}}});
    }
    const message = events.find(e => e.type === "transcript.item" && e.data.kind === "message");
    const delta = events.find(e => e.type === "transcript.delta");
    assert.equal(message.data.id, delta.data.id, "Completed text replaces the same streamed item");
    assert.equal(message.data.text, "Public progress");
    assert.equal(message.data.phase, "commentary");
    const tool = events.filter(e => e.data.id === "turn:tool:call");
    assert.equal(tool[0].data.title, "team_state");
    assert.equal(tool[0].data.status, "running");
    assert.equal(tool.at(-1).data.output, "actual result");
    assert.equal(tool.at(-1).data.status, "completed");
    assert(!JSON.stringify(events).includes("PRIVATE_REASONING"));
  });
}
