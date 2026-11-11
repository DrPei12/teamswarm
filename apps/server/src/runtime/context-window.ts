import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseToml } from "smol-toml";
import type { DatabaseSync } from "node:sqlite";
import {
  contextWindowPresets,
  type ContextWindowPlan,
  type ContextWindowPreset,
} from "@team/contracts/context-window";
import { apiEffortPolicy } from "@team/contracts/model-effort";
import type { ExecutionConfig } from "./types.js";

const positive = (x: unknown): number | null =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= 1024 ? x : null;
type Info = { normal: number; max: number; percent: number };
const accountModels = new Map<string, Map<string, Info>>();
function catalogRows(rows: unknown): Map<string, Info> {
  const map = new Map<string, Info>();
  if (Array.isArray(rows))
    for (const row of rows) {
      const normal = positive(row?.context_window),
        max = positive(row?.max_context_window) ?? normal;
      if (typeof row?.slug !== "string" || !normal || !max) continue;
      const pct = row.effective_context_window_percent;
      map.set(row.slug, {
        normal: Math.min(normal, max),
        max,
        percent: typeof pct === "number" && pct > 0 && pct <= 100 ? pct : 95,
      });
    }
  return map;
}
export function rememberAccountWindows(account: string, rows: unknown) {
  accountModels.set(account, catalogRows(rows));
}
let local:
  | {
      directory: string;
      checked: number;
      rows: Map<string, Info>;
      requested: number | null;
      compact: number | null;
    }
  | undefined;
function codexCatalog() {
  const directory = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  if (local?.directory === directory && Date.now() - local.checked < 60000)
    return local;
  let rows = new Map<string, Info>(),
    requested: number | null = null,
    compact: number | null = null;
  try {
    rows = catalogRows(
      JSON.parse(
        fs.readFileSync(path.join(directory, "models_cache.json"), "utf8"),
      ).models,
    );
  } catch {
    /* A native report can still supply capacity. */
  }
  try {
    const top = parseToml(
      fs.readFileSync(path.join(directory, "config.toml"), "utf8"),
    );
    requested = positive(top.model_context_window);
    compact = positive(top.model_auto_compact_token_limit);
  } catch {
    /* No local overrides. */
  }
  return (local = { directory, checked: Date.now(), rows, requested, compact });
}
export function savedWindowPreset(db: DatabaseSync): ContextWindowPreset {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='product_state'",
      )
      .get()
  )
    return "auto";
  const value = db
    .prepare(
      "SELECT json_extract(data,'$.contextWindowPreset') AS preset FROM product_state WHERE id=1",
    )
    .get()?.preset;
  return typeof value === "string" && Object.hasOwn(contextWindowPresets, value)
    ? (value as ContextWindowPreset)
    : "auto";
}
export const windowBinding = (window?: ContextWindowPlan) =>
  window
    ? [window.rawTokens, window.usableTokens, window.overrideNative]
    : undefined;
/** Native Codex tokenUsage windows are already effective. The other integrated APIs report raw capacity. */
export function effectiveWindow(
  plan: ContextWindowPlan,
  reported?: number | null,
  codex = false,
): number {
  if (!positive(reported) || reported! >= plan.rawTokens)
    return plan.usableTokens;
  return Math.min(
    plan.usableTokens,
    codex ? reported! : Math.floor((reported! * plan.effectivePercent) / 100),
  );
}
/** Known provider metadata takes precedence over legacy guessed Harness defaults. */
export function resolveContextWindow(
  config: ExecutionConfig | undefined,
  preset: ContextWindowPreset,
  reported?: number | null,
): ContextWindowPlan | undefined {
  if (!config) return undefined;
  const requested = contextWindowPresets[preset],
    legacy = positive(config.contextWindowTokens);
  let normal: number | null = null,
    max: number | null = null,
    percent = 95,
    source: ContextWindowPlan["source"] = "model",
    nativeCompact: number | null = null,
    overrideNative = true;
  if (apiEffortPolicy(config)) {
    // Both official models report context_window=1,048,576 on GET /models.
    normal = max = 1_048_576;
  } else if (
    config.model &&
    (config.chatgptAccountId ||
      (config.harness === "codex" && !config.baseUrl && !config.credentialEnv))
  ) {
    const catalog = codexCatalog(),
      info =
        (config.chatgptAccountId
          ? accountModels.get(config.chatgptAccountId)?.get(config.model)
          : undefined) ?? catalog.rows.get(config.model);
    if (info) {
      max = info.max;
      normal =
        config.harness === "codex"
          ? (catalog.requested ?? info.normal)
          : info.normal;
      percent = info.percent;
      if (preset === "auto" && config.harness === "codex")
        nativeCompact = catalog.compact;
    }
  }
  if (legacy) {
    normal = legacy;
    max = Math.min(max ?? legacy, legacy);
    if (source === "model" && !apiEffortPolicy(config))
      source = "configuration";
  }
  if (!normal) {
    if (positive(reported)) {
      normal = max = reported!;
      source = "native";
      overrideNative =
        preset !== "auto" && requested !== null && requested < normal;
      if (config.harness === "codex" && !overrideNative) percent = 100;
    } else if (
      config.harness === "pi" ||
      config.harness === "opencode" ||
      config.harness === "deepseek-harness"
    ) {
      normal = 131072;
      source = "configuration";
      overrideNative = !!requested;
    } else if (config.harness === "claude-code" && config.baseUrl) {
      normal = 200000;
      source = "estimate";
      overrideNative = !!requested;
    } else if (requested) {
      normal = requested;
      source = "estimate";
    } else return undefined;
  }
  const rawTokens = Math.min(requested ?? normal, max ?? Infinity);
  const nativeEffectiveOnly =
    source === "native" && config.harness === "codex" && !overrideNative;
  if (config.harness === "deepseek-harness") percent = 80;
  const outputReserve = nativeEffectiveOnly
    ? 0
    : Math.min(rawTokens / 4, config.maxOutputTokens ?? 8192);
  // DeepSeek Harness basic compaction defaults to min(80% of W, W - output - 65,536).
  // Scale extra headroom down for very small configured windows to leave a viable request.
  const extra =
    config.harness === "deepseek-harness"
      ? Math.min(65536, Math.floor(rawTokens / 2))
      : 0;
  const usableTokens = Math.max(
    1,
    Math.floor(
      Math.min(
        (rawTokens * percent) / 100,
        rawTokens - outputReserve - extra,
        nativeCompact ?? Infinity,
      ),
    ),
  );
  overrideNative =
    overrideNative &&
    ["codex", "claude-code", "deepseek-harness", "opencode", "pi"].includes(
      config.harness,
    );
  return {
    preset,
    rawTokens,
    usableTokens,
    modelMaxTokens: max,
    effectivePercent: percent,
    source,
    overrideNative,
  };
}

/** An earlier, smaller preset is not a model limit. Only clamp a known model
 * when the driver actually reported less than a window it was asked to use. */
export function memberContextWindow(
  db: DatabaseSync,
  teamId: string,
  memberId: string,
  config: ExecutionConfig,
  preset: ContextWindowPreset,
): ContextWindowPlan | undefined {
  const previous = db
    .prepare(
      `SELECT a.id,
    json_extract(a.data,'$.contextWindow') AS oldPlan,
    coalesce(json_extract(f.data,'$.context.contextWindowTokens'),json_extract(a.data,'$.usage.modelContextWindow'),json_extract(a.data,'$.usage.contextWindow')) AS reported
    FROM runtime_attempts a LEFT JOIN host_context_frames f ON f.attempt_id=a.id
    WHERE a.team_id=? AND json_extract(a.data,'$.memberId')=?
    AND json_extract(a.data,'$.config.harness')=? AND json_extract(a.data,'$.config.model') IS ?
    AND json_extract(a.data,'$.config.baseUrl') IS ? AND json_extract(a.data,'$.config.chatgptAccountId') IS ?
    AND json_extract(a.data,'$.config.credentialEnv') IS ? AND json_extract(a.data,'$.config.protocol') IS ?
    AND reported>0 ORDER BY a.rowid DESC LIMIT 1`,
    )
    .get(
      teamId,
      memberId,
      config.harness,
      config.model,
      config.baseUrl ?? null,
      config.chatgptAccountId ?? null,
      config.credentialEnv ?? null,
      config.protocol ?? null,
    );
  const reported = positive(previous?.reported);
  const old: ContextWindowPlan | undefined = previous?.oldPlan
    ? JSON.parse(String(previous.oldPlan))
    : undefined;
  const plan = resolveContextWindow(
    config,
    preset,
    old?.overrideNative ? undefined : reported,
  );
  if (!plan || !reported) return plan;
  const nativeEffective = config.harness === "codex";
  const smallerNativeLimit =
    old?.overrideNative &&
    reported < (nativeEffective ? old.usableTokens : old.rawTokens);
  if (smallerNativeLimit || (!plan.overrideNative && plan.source === "model")) {
    if (!nativeEffective && reported < plan.rawTokens)
      return {
        ...plan,
        rawTokens: reported,
        usableTokens: effectiveWindow(plan, reported),
        source: "native",
      };
    return {
      ...plan,
      usableTokens: effectiveWindow(plan, reported, nativeEffective),
    };
  }
  return plan;
}
