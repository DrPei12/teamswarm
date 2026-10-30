import test from "node:test";
import assert from "node:assert/strict";
import { conversationInput } from "../src/runtime/harness/conversation-input.js";

test("a rebuilt Host dialogue carries its previous answer before the current request", () => {
  const input = { turnPurpose: "dialogue", work: { instructions: "Recall your last reply" }, history: [
    { role: "user", content: "Read the file" }, { role: "assistant", content: "ACTUAL_FILE_CONTENT" },
  ] };
  const rendered = conversationInput(JSON.stringify(input));
  assert.match(rendered, /Earlier messages:\n\n.*"role":"assistant","content":"ACTUAL_FILE_CONTENT"/);
  assert.ok(rendered.endsWith(JSON.stringify([{ role: "user", content: "Recall your last reply" }])));
  assert.deepEqual(input.history[1], { role: "assistant", content: "ACTUAL_FILE_CONTENT" });
});

test("a member reply uses the incoming message rather than its original assignment", () => {
  const rendered = conversationInput(JSON.stringify({
    work: { memberId: "member", interaction: { messageIds: ["message"] } },
    requirement: { content: "Old assignment" },
    conversationHistory: [{ senderId: "member", content: "Latest answer" }],
    incomingMessages: [{ id: "message", senderId: "user", content: "My current question" }],
  }));
  assert.match(rendered, /Earlier messages:\n\n\[{"role":"assistant","content":"Latest answer"}\]/);
  assert.ok(rendered.endsWith(JSON.stringify([{ role: "user", content: "My current question" }])));
});

test("native callers and production assignments retain their input unchanged", () => {
  for (const input of ["plain input", "null", "{}", JSON.stringify({ work: { instructions: "Produce the artifact" }, turnPurpose: "task" })])
    assert.equal(conversationInput(input), input);
});
