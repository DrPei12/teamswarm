import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { reworkEnvironment } from '../scripts/start-rework.mjs';

test('rework startup replaces inherited desktop data, project, profile and account locations', () => {
  const root = path.resolve('fixture-rework');
  const env = reworkEnvironment(root, {
    PATH: 'unchanged-runtime-path', TEAM_DATA_DIR: 'live-desktop-data', TEAM_PROJECTS_DIR: 'live-projects',
    TEAMSWARM_USER_DATA: 'live-profile', TEAM_ACCOUNT_HOME: 'live-accounts', TEAM_HARNESS_HOME: 'live-harnesses', TEAM_API_PORT: '4317',
    TEAM_CODEX_HOME: 'live-native-codex', CODEX_HOME: 'inherited-codex-client', TEAMSWARM_TEMP_DIR: 'live-desktop-temp',
    TEAMSWARM_REWORK_PROFILE: 'experiment-a', TEAMSWARM_REWORK_PORT: '4429',
  });
  const expected = path.join(root, '.local/rework/experiment-a');
  for (const [key, directory] of Object.entries({ TEAM_DATA_DIR: 'data', TEAM_PROJECTS_DIR: 'projects', TEAMSWARM_USER_DATA: 'profile', TEAM_ACCOUNT_HOME: 'accounts', TEAM_HARNESS_HOME: 'harnesses' }))
    assert.equal(env[key], path.join(expected, directory));
  assert.equal(env.PATH, 'unchanged-runtime-path');
  assert.equal(env.TEAM_API_PORT, '4429');
  assert.equal(env.TEAM_CODEX_HOME, path.join(expected, 'accounts', 'codex'));
  assert.equal(env.TEAMSWARM_TEMP_DIR, path.join(expected, 'tmp'));
  assert.equal(env.CODEX_HOME, 'inherited-codex-client');
  assert.notEqual(reworkEnvironment(root, {}).TEAM_DATA_DIR, env.TEAM_DATA_DIR);
  assert.throws(() => reworkEnvironment(root, { TEAMSWARM_REWORK_PROFILE: '../desktop' }));
  assert.throws(() => reworkEnvironment(root, { TEAMSWARM_REWORK_PORT: '0' }));
});
