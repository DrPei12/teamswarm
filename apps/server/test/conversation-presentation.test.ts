import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptItem } from "@team/contracts/product";
import {
  groupActivity,
  delegationRows,
  toolValue,
} from "../../../teamswarm/src/activityPresentation.js";
import { supportedEfforts } from "../../../teamswarm/src/harnessCatalog.js";
import { executionConfig } from "../src/runtime/validation.js";

const tool = (
  id: string,
  title: string,
  text = {},
  output = {},
  status: TranscriptItem["status"] = "completed",
): TranscriptItem => ({
  id,
  kind: "tool",
  title,
  text: JSON.stringify(text),
  output: JSON.stringify([{ type: "inputText", text: JSON.stringify(output) }]),
  status,
});

test("activity groups unwrap native receipts, preserve failures and resolve actual member assignments", () => {
  const items = [
    tool("state", "team_state"),
    tool(
      "create-a",
      "team_add_member",
      { name: "作者", responsibility: "编写说明" },
      { id: "a" },
    ),
    tool("read", "team_project_context", {}, {}, "failed"),
    tool(
      "create-b",
      "team_add_member",
      { name: "核对", responsibility: "读取验收" },
      { id: "b" },
    ),
    tool("work-a", "team_delegate", { memberId: "a", title: "写说明" }),
    tool(
      "work-b",
      "team_delegate",
      { memberId: "b", title: "检查原文" },
      {},
      "interrupted",
    ),
    tool("define", "team_define_requirements", { objective: "保留原文" }),
  ];
  const groups = groupActivity(items);
  assert.deepEqual(
    groups.map((g) => g.kind),
    ["context", "delegation", "item"],
  );
  assert.equal(groups.flatMap((g) => g.items).length, items.length);
  assert.equal(groups[0].items[1].status, "failed");
  const rows = delegationRows(groups[1].items, []);
  assert.deepEqual(
    rows.map((r) => [r.name, r.responsibility, r.assignments[0].id]),
    [
      ["作者", "编写说明", "work-a"],
      ["核对", "读取验收", "work-b"],
    ],
  );
  assert.equal(rows[1].assignments[0].status, "interrupted");
  assert.equal(
    toolValue(
      JSON.stringify([{ type: "inputText", text: "Permission denied" }]),
    ).message,
    "Permission denied",
  );
  const failed = delegationRows(
    [
      tool("create", "team_add_member", { name: "新成员" }, {}, "failed"),
      tool("delegate", "team_delegate", {
        memberId: "existing",
        title: "复核",
      }),
    ],
    [{ id: "existing", name: "现有成员" }],
  );
  assert.equal(failed[0].created?.status, "failed");
  assert.equal(failed[1].name, "现有成员");
});

test("effort choices follow the current model capability and accept future provider names without cross-model fallbacks", () => {
  const catalog = {
    models: [
      {
        model: "a",
        name: "A",
        isDefault: true,
        reasoningEfforts: [
          { reasoningEffort: "low" },
          { reasoningEffort: "future_level" },
        ],
      },
      {
        model: "b",
        name: "B",
        reasoningEfforts: [{ reasoningEffort: "medium" }],
      },
    ],
  };
  assert.deepEqual(
    supportedEfforts(catalog, null).map((e) => e.reasoningEffort),
    ["low", "future_level"],
  );
  assert.deepEqual(
    supportedEfforts(catalog, "b").map((e) => e.reasoningEffort),
    ["medium"],
  );
  assert.deepEqual(supportedEfforts(catalog, "custom"), []);
  assert.deepEqual(
    supportedEfforts(
      { ...catalog, capabilities: { reasoningEffort: false } },
      "a",
    ),
    [],
  );
  assert.deepEqual(supportedEfforts(null, "a"), []);
  assert.equal(
    executionConfig.parse({ effort: "future_level" }).effort,
    "future_level",
  );
  assert.equal(
    executionConfig.safeParse({ effort: "invalid\nvalue" }).success,
    false,
  );
});
