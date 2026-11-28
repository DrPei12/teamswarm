import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedResponsesTools } from './native/responses-tool-boundary.mjs';

const read = { type: 'function', name: 'team_read_artifact', parameters: { type: 'object' } };
const namespaced = (...tools) => ({ type: 'namespace', name: 'mcp__teamswarm', tools });
const declarations = tools => ({ type: 'additional_tools', role: 'developer', tools });

test('Luna acceptance allows Codex Responses namespaces and flat ToolBridge declarations', () => {
  assert(allowedResponsesTools({ tools: [namespaced(read)], input: [declarations([read]), { role: 'user', content: 'Inspect the fixture.' }] }));
  assert(allowedResponsesTools({ input: [declarations([{ type: 'custom', name: 'read_fixture' }])] }));
});

test('Luna acceptance does not permit hosted tools in either declaration location', () => {
  const hosted = { type: 'web_search' };
  for (const tools of [[hosted], [namespaced(read, hosted)], [namespaced(namespaced(read))], [namespaced()], [null], null]) {
    assert.equal(allowedResponsesTools({ tools }), false);
    assert.equal(allowedResponsesTools({ input: [declarations(tools)] }), false);
  }
});
