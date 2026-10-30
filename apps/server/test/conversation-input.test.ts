import test from "node:test";
import assert from "node:assert/strict";
import { conversationInput } from "../src/runtime/harness/conversation-input.js";

test("a rebuilt Host dialogue carries its previous answer before the current request", () => {
  const input = { turnPurpose: "dialogue", work: { instructions: "Recall your last reply" }, history: [
    { role: "user", content: "Read the file" }, { role: "assistant", content: "ACTUAL_FILE_CONTENT" },
  ] };
  const rendered = conversationInput(JSON.stringify(input));
  assert.match(rendered, /Most recent messages \(oldest first\):\n\nUser:\nRead the file\n\nAssistant:\nACTUAL_FILE_CONTENT/);
  assert.ok(rendered.endsWith("Current message:\n\nUser:\nRecall your last reply"));
  assert.deepEqual(input.history[1], { role: "assistant", content: "ACTUAL_FILE_CONTENT" });
});

test("a member reply uses the incoming message rather than its original assignment", () => {
  const rendered = conversationInput(JSON.stringify({
    work: { memberId: "member", interaction: { messageIds: ["message"] } },
    requirement: { content: "Old assignment" },
    conversationHistory: [{ senderId: "member", content: "Latest answer" }],
    incomingMessages: [{ id: "message", senderId: "user", content: "My current question" }],
  }));
  assert.match(rendered, /Most recent messages \(oldest first\):\n\nAssistant:\nLatest answer/);
  assert.ok(rendered.endsWith("Current message:\n\nUser:\nMy current question"));
  assert.equal(rendered.split("My current question").length - 1, 1);
});

test("a long conversation keeps the last exchange adjacent to the current request", () => {
  const rendered = conversationInput(JSON.stringify({
    work: { memberId: "member", interaction: { messageIds: ["current"] } },
    conversationHistory: [
      { senderId: "member", content: "OLD_TASK_RESULT" },
      { senderId: "user", content: "Read another file" },
      { senderId: "member", content: "CURRENT_FILE_RESULT\nsecond line" },
    ],
    incomingMessages: [{ senderId: "user", content: "Repeat your last reply" }],
  }));
  assert.ok(rendered.endsWith("Most recent messages (oldest first):\n\nUser:\nRead another file\n\nAssistant:\nCURRENT_FILE_RESULT\nsecond line\n\nCurrent message:\n\nUser:\nRepeat your last reply"));
  assert.ok(rendered.indexOf("OLD_TASK_RESULT") < rendered.indexOf("Most recent messages"));
});

test("native callers and production assignments retain their input unchanged", () => {
  for (const input of ["plain input", "null", "{}", JSON.stringify({ work: { instructions: "Produce the artifact" }, turnPurpose: "task" })])
    assert.equal(conversationInput(input), input);
});
