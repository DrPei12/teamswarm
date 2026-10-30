import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const manifest = {
  schemaVersion: 1, id: 'qwen-code', name: 'Qwen Code', packageVersion: '1.0.0', driver: 'acp',
  runtime: { package: '@qwen-code/qwen-code', version: '0.26.4', entries: ['@qwen-code/qwen-code/cli-entry.js'], testedVersions: ['0.26.4'], homepage: 'https://github.com/QwenLM/qwen-code' },
  models: { protocols: ['chat-completions'], preferredProtocol: 'chat-completions', nativeLogin: false, thinkingFormats: {}, outputBudget: false, contextWindow: false },
  permissions: {
    schema: { type: 'object', properties: { harness: { const: 'qwen-code', type: 'string' }, approvalMode: { type: 'string', enum: ['default', 'auto-edit', 'plan'] } }, required: ['harness', 'approvalMode'], additionalProperties: false },
    readOnly: { set: { approvalMode: 'plan' } },
  },
  session: { resume: true },
  description: {
    execution: { runtime: 'Qwen Code ACP', tools: ['native shell', 'native file tools'], strategy: 'Qwen Code owns its native tool loop and shell execution.', backgroundTasks: 'Automatic title, follow-up suggestions, memory extraction, dream and skill generation are disabled. Native session history and explicitly assigned work remain available.' },
    permissions: { behavior: 'default requests native approvals; auto-edit permits native edits; plan uses the native planning restrictions. ACP approvals are one-time decisions.' },
    results: { source: 'ACP tool_call and tool_call_update', cancellation: 'session/cancel, then owned process termination if needed' },
    isolation: { win32: 'Native permissions; no OS sandbox is added by this adapter', default: 'Native Qwen permissions; OS sandbox requires separate native configuration' },
  },
};

export function createHarness(context) {
  if (context.apiVersion !== 1) throw new Error('Unsupported TeamSwarm adapter API.');
  return context.createAcpHarness(manifest, {
    prepare({ request, home, env }) {
      const config = request.config;
      for (const key of Object.keys(env)) if (/^QWEN_/i.test(key)) delete env[key];
      const settings = path.join(home, '.qwen');
      mkdirSync(settings, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(settings, 'settings.json'), JSON.stringify({
        security: { auth: { selectedType: 'openai' } }, model: { name: config.model },
        modelProviders: { openai: [{ id: config.model, name: config.model, baseUrl: config.baseUrl, envKey: 'OPENAI_API_KEY' }] },
        telemetry: { enabled: false },
        ui: { enableFollowupSuggestions: false, enableSpeculation: false },
        memory: { enableManagedAutoMemory: false, enableManagedAutoDream: false, enableAutoSkill: false },
      }), { mode: 0o600 });
      return {
        args: ['--acp', '--model', config.model, '--approval-mode', config.permissions?.approvalMode ?? (config.access === 'read-only' ? 'plan' : 'default')],
        env: { ...env, HOME: home, USERPROFILE: home, QWEN_HOME: settings, QWEN_DISABLE_AUTO_TITLE: '1', OPENAI_API_KEY: env[config.credentialEnv], OPENAI_BASE_URL: config.baseUrl, OPENAI_MODEL: config.model },
      };
    },
  });
}
