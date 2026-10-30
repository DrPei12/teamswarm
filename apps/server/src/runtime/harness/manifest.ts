import { z } from 'zod';
import { Ajv } from 'ajv';
import type { HarnessManifest } from '@team/contracts/harness-catalog';
import { harnessManifest } from '@team/contracts/harness-catalog';
const wire = z.enum(['responses', 'chat-completions', 'anthropic-messages']);
const object = z.record(z.string(), z.unknown());
export const manifestSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  name: z.string().min(1).max(100), packageVersion: z.string().min(1).max(100), driver: z.string().min(1).max(100),
  runtime: z.object({ package: z.string().min(1), version: z.string().min(1), entries: z.array(z.string().min(1)).min(1), testedVersions: z.array(z.string().min(1)).min(1), homepage: z.url().optional() }).strict().optional(),
  models: z.object({ protocols: z.array(wire).min(1), preferredProtocol: wire, chatgptProtocol: wire.nullable().optional(), nativeLogin: z.boolean(), nativeEffort: z.object({ values: z.union([z.literal('any'), z.array(z.string())]), nativeLoginOnly: z.boolean().optional(), protocols: z.array(wire).optional() }).strict().nullable().optional(), thinkingFormats: z.record(z.string(), z.array(wire)), outputBudget: z.boolean(), contextWindow: z.boolean() }).strict(),
  permissions: z.object({ schema: object, readOnly: z.object({ set: object.optional(), exclude: z.record(z.string(), z.array(z.string())).optional() }).strict() }).strict(),
  session: z.object({ resume: z.boolean() }).strict(),
  description: z.object({ execution: object, permissions: object, results: object, isolation: object }).strict(),
}).strict();
const ajv = new Ajv({ strict: true, allErrors: true, validateFormats: false });
const validators = new WeakMap<object, ReturnType<typeof ajv.compile>>();
export function permissionValidator(manifest: HarnessManifest) {
  let validator = validators.get(manifest);
  if (!validator) { validator = ajv.compile(manifest.permissions.schema); validators.set(manifest, validator); }
  return validator;
}
export function validateManifest(input: unknown): HarnessManifest {
  const m = manifestSchema.parse(input);
  if (!m.models.protocols.includes(m.models.preferredProtocol) || m.models.chatgptProtocol && !m.models.protocols.includes(m.models.chatgptProtocol)) throw new Error('Preferred model protocol must be supported by the Harness.');
  const p = m.permissions.schema as any;
  if (p.type !== 'object' || p.properties?.harness?.const !== m.id || !p.required?.includes('harness')) throw new Error('Permission schema must require this package\'s Harness identity.');
  if (m.runtime?.entries.some(e => e.startsWith('/') || e.includes('..') || e.includes('\\') || e.includes(':'))) throw new Error('Native package entries must be relative package paths.');
  permissionValidator(m);
  return m;
}
export function validatePolicy(input: unknown): string | null {
  const policy = input as { harness?: string } | null;
  const manifest = policy?.harness && harnessManifest(policy.harness);
  if (!manifest) return 'Unknown Harness permission policy.';
  const check = permissionValidator(manifest);
  return check(input) ? null : ajv.errorsText(check.errors, { separator: '; ' });
}
