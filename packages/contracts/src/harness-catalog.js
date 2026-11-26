import builtins from './harness-manifests.json' with { type: 'json' };
import { apiEffortPolicy } from './model-effort.js';
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const catalog = new Map(builtins.map(m => [m.id, freeze(m)]));
export function harnessManifest(id) { return catalog.get(id); }
export function harnessManifests() { return [...catalog.values()]; }
export function supportsNativeReadProbes(config) {
  if (config.access !== 'read-only' || !config.baseUrl || !config.credentialEnv) return false;
  if (config.harness === 'deepseek-harness') return (config.permissions?.sandbox ?? 'read-only') === 'read-only';
  return ['pi', 'claude-code', 'opencode'].includes(config.harness) &&
    config.protocol === 'chat-completions' && Boolean(apiEffortPolicy(config));
}
export function registerHarnessManifest(manifest) {
  if (catalog.has(manifest.id)) throw new Error(`Harness package already registered: ${manifest.id}`);
  const stored = freeze(structuredClone(manifest));
  catalog.set(stored.id, stored);
  return () => { if (catalog.get(stored.id) === stored) catalog.delete(stored.id); };
}
export function replaceHarnessManifests(manifests) {
  const next = new Map(manifests.map(m => [m.id, freeze(structuredClone(m))]));
  if (next.size !== manifests.length) throw new Error('Duplicate Harness package IDs.');
  catalog.clear(); next.forEach((m, id) => catalog.set(id, m));
}
