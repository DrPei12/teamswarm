export type ContextWindowPreset = "auto" | "128k" | "256k" | "512k" | "1m";
export const contextWindowPresets: Readonly<
  Record<ContextWindowPreset, number | null>
>;
export const contextWindowPresetIds: readonly [
  ContextWindowPreset,
  ...ContextWindowPreset[],
];
/** Frozen for an attempt; effective native reports may further reduce the usable window. */
export interface ContextWindowPlan {
  preset: ContextWindowPreset;
  rawTokens: number;
  usableTokens: number;
  modelMaxTokens: number | null;
  effectivePercent: number;
  source: "model" | "native" | "configuration" | "estimate";
  overrideNative: boolean;
}
