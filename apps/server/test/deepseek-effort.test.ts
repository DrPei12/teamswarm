import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { apiEffortPolicy } from "@team/contracts/model-effort";
import { ModelGateway } from "../src/runtime/model-gateway.js";
import { executionConfig } from "../src/runtime/validation.js";
import {
  executionCompatibility,
  needsModelRoute,
} from "../src/runtime/model-routing.js";
import {
  attemptExecution,
  executionConfiguration,
} from "../src/runtime/execution-status.js";
import type { Attempt, ModelRequestReceipt } from "../src/runtime/types.js";

test("DeepSeek provider presets reach the serialized wire and Host receipt for each protocol", async () => {
  const gateway = new ModelGateway(
    mkdtempSync(path.resolve(".test-deepseek-effort-")),
  );
  const original = globalThis.fetch,
    sent: any[] = [];
  process.env.EFFORT_FIXTURE_KEY = "synthetic-only";
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "127.0.0.1") return original(input, init);
    assert.equal(url.origin, "https://api.deepseek.com");
    const body = JSON.parse(String(init?.body));
    sent.push(body);
    const data = {
      id: "test",
      object: "chat.completion.chunk",
      model: body.model,
      created: 1,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
    };
    return new Response(
      "data: " + JSON.stringify(data) + "\n\ndata: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    const combinations = [
      ["responses", "responses"],
      ["anthropic-messages", "anthropic-messages"],
      ["chat-completions", "chat-completions"],
      ["chat-completions", "anthropic-messages"],
    ] as const;
    for (const [source, wire] of combinations)
      for (const selected of [null, "none", "low", "high", "max"]) {
        const c = executionConfig.parse({
          harness: "deepseek-harness",
          model: "deepseek-flash",
          protocol: source,
          baseUrl: "https://api.deepseek.com",
          credentialEnv: "EFFORT_FIXTURE_KEY",
          effort: selected,
        });
        assert(needsModelRoute(c));
        assert.deepEqual(executionCompatibility(c), []);
        const policy = apiEffortPolicy(c)!;
        assert.equal(policy.defaultEffort, "high");
        assert.deepEqual(policy.supported, ["none", "low", "high", "max"]);
        const lease = await gateway.lease(c);
        const receipts: ModelRequestReceipt[] = [];
        lease.observe((r) => receipts.push(r));
        try {
          const endpoint =
            wire === "responses"
              ? "/responses"
              : wire === "anthropic-messages"
                ? "/messages"
                : "/chat/completions";
          const msg = [{ role: "user", content: "Only synthetic text." }];
          const body =
            wire === "responses"
              ? {
                  input: msg,
                  reasoning: { effort: "minimal", summary: "auto" },
                }
              : wire === "chat-completions"
                ? {
                    messages: msg,
                    thinking: { type: "disabled" },
                    reasoning_effort: "medium",
                  }
                : {
                    messages: msg,
                    thinking: { type: "disabled" },
                    output_config: { effort: "low" },
                  };
          const result = await original(lease.config.baseUrl + endpoint, {
            method: "POST",
            headers: {
              authorization: "Bearer " + lease.token,
              "x-api-key": lease.token,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              ...body,
              model: c.model,
              stream: true,
              max_tokens: 64,
            }),
          });
          const output = await result.text();
          assert.equal(result.status, 200, output);
          const payload = sent.at(-1),
            receipt = receipts.at(-1)!;
          assert.equal(receipt.status, "accepted");
          if (source === "chat-completions") {
            assert.equal(payload.reasoning_effort, selected ?? undefined);
            assert.equal(payload.thinking, undefined);
          }
          if (source === "responses")
            assert.equal(payload.reasoning?.effort, selected ?? undefined);
          if (source === "anthropic-messages") {
            assert.equal(
              payload.output_config?.effort,
              selected === "none" ? undefined : (selected ?? undefined),
            );
            assert.equal(
              payload.thinking?.type,
              selected === null
                ? undefined
                : selected === "none"
                  ? "disabled"
                  : "enabled",
            );
          }
          assert.equal(receipt.effort, selected);
          assert.equal(receipt.effectiveEffort, selected ?? "high");
          assert.equal(
            receipt.effortSource,
            selected ? "explicit" : "provider_default",
          );
          assert.equal(
            receipt.effortParameter,
            selected === null
              ? null
              : source === "chat-completions"
                ? "reasoning_effort"
                : source === "responses"
                  ? "reasoning.effort"
                  : selected === "none"
                    ? "thinking.type"
                    : "output_config.effort",
          );
          const info = attemptExecution({
            config: c,
            modelRequest: receipt,
          } as Attempt);
          assert.equal(info.effectiveEffort, selected ?? "high");
          assert.equal(info.effort, selected);
        } finally {
          lease.release();
        }
      }
    const c = executionConfig.parse({
      harness: "deepseek-harness",
      model: "deepseek-flash",
      baseUrl: "https://api.deepseek.com",
      protocol: "chat-completions",
    });
    assert.equal(
      apiEffortPolicy({ ...c, baseUrl: "https://api.deepseek.com.example" }),
      null,
    );
    assert.equal(apiEffortPolicy({ ...c, model: "unknown" }), null);
    assert.equal(executionConfiguration(c).effectiveEffort, "high");
    assert.equal(
      attemptExecution({ config: c, modelRequest: { effort: null } } as Attempt)
        .effectiveEffort,
      null,
    );
  } finally {
    globalThis.fetch = original;
    delete process.env.EFFORT_FIXTURE_KEY;
    await gateway.close();
  }
});
test("DeepSeek tools retain the last assistant reasoning block when the default effort is implicit", async () => {
  // Synthetic reasoning marker exercises the provider's tool-call continuation requirement.
  const dir = mkdtempSync(path.resolve(".test-deepseek-tools-"));
  const gateway = new ModelGateway(dir),
    original = globalThis.fetch,
    sent: any[] = [];
  process.env.EFFORT_FIXTURE_KEY = "synthetic-only";
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "127.0.0.1") return original(input, init);
    assert.equal(url.origin, "https://api.deepseek.com");
    sent.push(JSON.parse(String(init?.body)));
    const first = sent.length === 1;
    const chunks = first
      ? [
          { role: "assistant", reasoning_content: "SYNTHETIC_STEP" },
          {
            tool_calls: [
              {
                index: 0,
                id: "call_state",
                type: "function",
                function: { name: "team_state", arguments: "{}" },
              },
            ],
          },
        ]
      : [{ role: "assistant", content: "ok" }];
    let s = "";
    for (const delta of [...chunks, {}]) {
      const last = Object.keys(delta).length === 0;
      s +=
        "data: " +
        JSON.stringify({
          id: "msg_0",
          model: "deepseek-flash",
          object: "chat.completion.chunk",
          created: 1,
          choices: [
            {
              index: 0,
              delta,
              finish_reason: last ? (first ? "tool_calls" : "stop") : null,
            },
          ],
        }) +
        "\n\n";
    }
    return new Response(s + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  };
  try {
    const config = executionConfig.parse({
      harness: "deepseek-harness",
      model: "deepseek-flash",
      protocol: "chat-completions",
      baseUrl: "https://api.deepseek.com",
      credentialEnv: "EFFORT_FIXTURE_KEY",
    });
    const lease = await gateway.lease(config);
    lease.session("fixture", dir);
    try {
      const messages: any[] = [
        { role: "user", content: "Use the test state tool." },
      ];
      const call = async () => {
        const r = await original(lease.config.baseUrl + "/messages", {
          method: "POST",
          headers: {
            "x-api-key": lease.token,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: config.model,
            messages,
            tools: [
              {
                name: "team_state",
                description: "test",
                input_schema: { type: "object", properties: {} },
              },
            ],
            max_tokens: 64,
          }),
        });
        const value = (await r.json()) as any;
        assert.equal(r.status, 200, JSON.stringify(value));
        return value;
      };
      const response = await call(),
        tool = response.content.find((c: any) => c.type === "tool_use");
      assert(tool);
      messages.push(
        { role: "assistant", content: response.content },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: tool.id, content: "{}" },
          ],
        },
      );
      await call();
      assert.equal(
        sent[1].messages.find((m: any) => m.role === "assistant")
          ?.reasoning_content,
        "SYNTHETIC_STEP",
      );
    } finally {
      lease.release();
    }
  } finally {
    globalThis.fetch = original;
    delete process.env.EFFORT_FIXTURE_KEY;
    await gateway.close();
  }
});
