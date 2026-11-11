/** Decimal window ceilings as displayed in the settings. Auto uses model metadata. */
export const contextWindowPresets = Object.freeze({
  auto: null,
  "128k": 128000,
  "256k": 256000,
  "512k": 512000,
  "1m": 1000000,
});
export const contextWindowPresetIds = Object.freeze(
  Object.keys(contextWindowPresets),
);
