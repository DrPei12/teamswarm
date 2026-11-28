import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const manifest = {
  schemaVersion: 1, id: 'qwen-code', name: 'Qwen Code', packageVersion: '1.2.0', driver: 'acp',
  runtime: { package: '@qwen-code/qwen-code', version: '0.26.4', entries: ['@qwen-code/qwen-code/cli-entry.js'], testedVersions: ['0.26.4'], homepage: 'https://github.com/QwenLM/qwen-code' },
  models: { protocols: ['chat-completions'], preferredProtocol: 'chat-completions', nativeLogin: false, thinkingFormats: {}, outputBudget: false, contextWindow: false },
  permissions: {
    schema: { type: 'object', properties: { harness: { const: 'qwen-code', type: 'string' }, approvalMode: { type: 'string', enum: ['default', 'auto-edit', 'plan', 'auto', 'teamswarm-auto', 'yolo'] } }, required: ['harness', 'approvalMode'], additionalProperties: false },
    readOnly: { set: { approvalMode: 'plan' } },
  },
  session: { resume: true },
  integration: {
    platforms: ['win32', 'darwin', 'linux'],
    presets: {
      'read-only': { harness: 'qwen-code', approvalMode: 'plan' },
      manual: { harness: 'qwen-code', approvalMode: 'default' },
      auto: { harness: 'qwen-code', approvalMode: 'teamswarm-auto' },
      'full-access': { harness: 'qwen-code', approvalMode: 'yolo' },
    },
    automaticReviewer: 'teamswarm',
  },
  description: {
    execution: { runtime: 'Qwen Code ACP', tools: ['native shell', 'native file tools'], strategy: 'Qwen Code owns its native tool loop and shell execution.', backgroundTasks: 'Automatic title, follow-up suggestions, memory extraction, dream and skill generation are disabled. Native session history and explicitly assigned work remain available.' },
    permissions: { behavior: 'Plan restricts writes and commands. Default requests ACP approval. Automatic review uses the TeamSwarm gateway and scoped file tools. Yolo grants the native tools full access.' },
    results: { source: 'ACP tool_call and tool_call_update', cancellation: 'session/cancel, then owned process termination if needed' },
    isolation: { win32: 'Native permissions; no OS sandbox is added by this adapter', default: 'Native Qwen permissions; OS sandbox requires separate native configuration' },
  },
};

export function createHarness(context) {
  if (context.apiVersion !== 1) throw new Error('Unsupported TeamSwarm adapter API.');
  return context.createAcpHarness(manifest, {
    allowsSharedWorkspace(request) {
      if (request.config.access === 'read-only') return true;
      return request.hostWorkspaceWrite === true && !Object.values(request.requirements).some(Boolean);
    },
    prepare({ request, home, env }) {
      const config = request.config;
      const mode = config.permissions?.approvalMode;
      const auto = config.access === 'workspace-write' && (mode === 'teamswarm-auto' || mode === 'auto');
      if (auto && !request.modelRoute) throw new Error('Qwen Code automatic review requires the TeamSwarm model gateway.');
      const teamTools = request.tools.filter(tool => context.runtime.teamReadTools.includes(tool.name) || tool.name === 'team_host_inline_edit' ||
        auto && (tool.name === 'team_write_file' || tool.name === 'team_edit_file'));

      for (const key of Object.keys(env)) if (/^QWEN_/i.test(key)) delete env[key];
      const settings = path.join(home, '.qwen');
      mkdirSync(settings, { recursive: true, mode: 0o700 });
      const automaticRules = auto ? path.join(home, 'teamswarm-automatic.json') : undefined;
      if (automaticRules) writeFileSync(automaticRules, JSON.stringify({ disableAllHooks: true }), { mode: 0o600 });
      writeFileSync(path.join(settings, 'settings.json'), JSON.stringify({
        security: { auth: { selectedType: 'openai' } }, model: { name: config.model },
        permissions: { allow: teamTools.map(tool => 'mcp__teamswarm__' + tool.name) },
        modelProviders: { openai: [{ id: config.model, name: config.model, baseUrl: config.baseUrl, envKey: 'OPENAI_API_KEY' }] },
        telemetry: { enabled: false },
        ui: { enableFollowupSuggestions: false, enableSpeculation: false },
        memory: { enableManagedAutoMemory: false, enableManagedAutoDream: false, enableAutoSkill: false },
      }), { mode: 0o600 });
      return {
        args: ['--acp', '--model', config.model, '--approval-mode', config.access === 'read-only' ? 'plan' : auto ? 'default' : mode ?? 'default'],
        env: { ...env, HOME: home, USERPROFILE: home, QWEN_HOME: settings, QWEN_DISABLE_AUTO_TITLE: '1',
          ...(automaticRules ? { QWEN_CODE_SYSTEM_SETTINGS_PATH: automaticRules } : {}),
          OPENAI_API_KEY: env[config.credentialEnv], OPENAI_BASE_URL: config.baseUrl, OPENAI_MODEL: config.model },
      };
    },
  });
}
