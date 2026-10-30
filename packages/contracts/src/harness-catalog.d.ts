import type { ConnectionProtocol } from './allocation.js';
export interface HarnessManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  packageVersion: string;
  driver: string;
  runtime?: { package: string; version: string; entries: string[]; testedVersions: string[]; homepage?: string };
  models: {
    protocols: ConnectionProtocol[];
    preferredProtocol: ConnectionProtocol;
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
  description: Record<'execution' | 'permissions' | 'results' | 'isolation', Record<string, unknown>>;
}
export function harnessManifest(id: string): HarnessManifest | undefined;
export function harnessManifests(): HarnessManifest[];
/** Input is validated by the server package loader before registration. */
export function registerHarnessManifest(manifest: HarnessManifest): () => void;
/** Browser catalog snapshot from the authenticated service. */
export function replaceHarnessManifests(manifests: HarnessManifest[]): void;
