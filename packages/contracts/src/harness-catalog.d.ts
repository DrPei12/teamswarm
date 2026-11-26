import type { ConnectionProtocol } from './allocation.js';
import type { ExecutionConfig } from './runtime.js';
export interface HarnessManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  packageVersion: string;
  driver: string;
  runtime?: { package: string; version: string; entries: string[]; testedVersions: string[]; homepage?: string };
  models: {
    protocols: ConnectionProtocol[];
    preferredProtocol: ConnectionProtocol | null;
    nativeOnly?: boolean;
    chatgptProtocol?: ConnectionProtocol | null;
    nativeLogin: boolean;
    nativeEffort?: { values: 'any' | string[]; nativeLoginOnly?: boolean; protocols?: ConnectionProtocol[] } | null;
    thinkingFormats: Record<string, ConnectionProtocol[]>;
    outputBudget: boolean;
    contextWindow: boolean;
  };
  permissions: {
    schema: Record<string, unknown>;
    readOnly: { set?: Record<string, unknown>; exclude?: Record<string, string[]> };
  };
  session: { resume: boolean };
  /** Complete packages declare the platform boundary and each supported permission preset. */
  integration?: {
    platforms: string[];
    presets: Record<'read-only' | 'manual' | 'auto' | 'full-access', Record<string, unknown>>;
    automaticReviewer: 'native' | 'teamswarm';
  };
  description: Record<'execution' | 'permissions' | 'results' | 'isolation', Record<string, unknown>>;
}
export function harnessManifest(id: string): HarnessManifest | undefined;
export function harnessManifests(): HarnessManifest[];
export function supportsNativeReadProbes(config: ExecutionConfig): boolean;
/** Input is validated by the server package loader before registration. */
export function registerHarnessManifest(manifest: HarnessManifest): () => void;
/** Browser catalog snapshot from the authenticated service. */
export function replaceHarnessManifests(manifests: HarnessManifest[]): void;
