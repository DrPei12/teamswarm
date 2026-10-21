import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createApp, type TeamService } from '../src/app.js';

interface RunningService {
  service: TeamService;
  server: ReturnType<TeamService['app']['listen']>;
  baseUrl: string;
  close: () => Promise<void>;
}

async function listen(service: TeamService, webDistDir: string): Promise<RunningService> {
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('Test server did not expose a TCP address.');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    service,
    server,
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await service.close();
    },
  };
}

async function open(dataDir: string, webDistDir: string): Promise<RunningService> {
  return listen(createApp({ dataDir, webDistDir, apiPort: 4318 }), webDistDir);
}

async function request(
  running: RunningService,
  route: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any; text: string }> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${running.service.controlToken}`);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`${running.baseUrl}${route}`, { ...init, headers });
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Plain text is useful for the static fallback assertion.
  }
  return { status: response.status, body, text };
}

test('browser sessions remain isolated across local workspace ports and migrate existing desktop sessions', async () => {
  const directory = await mkdtemp(path.join(process.cwd(), '.test-session-'));
  const first = await open(path.join(directory, 'first'), path.join(directory, 'web'));
  const second = await open(path.join(directory, 'second'), path.join(directory, 'web'));
  try {
    const sessions: string[] = [];
    for (const running of [first, second]) {
      const response = await fetch(`${running.baseUrl}/api/control/session`, {
        method: 'POST',
        headers: { authorization: `Bearer ${running.service.controlToken}` },
      });
      assert.equal(response.status, 200);
      const header = response.headers.get('set-cookie')!;
      assert.match(header, /HttpOnly/);
      assert.match(header, /SameSite=Strict/);
      assert.match(header, /Path=\/api/);
      sessions.push(header.split(';')[0]);
    }
    assert.notEqual(sessions[0].split('=')[0], sessions[1].split('=')[0]);
    const sharedBrowserCookie = [...sessions, `teamswarm_control=${second.service.controlToken}`].join('; ');
    for (const running of [first, second]) {
      const response = await fetch(`${running.baseUrl}/api/teams`, { headers: { cookie: sharedBrowserCookie } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { teams: [] });
    }
    const crossWorkspace = await fetch(`${first.baseUrl}/api/teams`, { headers: { cookie: sessions[1] } });
    assert.equal(crossWorkspace.status, 401);
    const wrongBearer = await fetch(`${first.baseUrl}/api/teams`, {
      headers: { cookie: sharedBrowserCookie, authorization: `Bearer ${second.service.controlToken}` },
    });
    assert.equal(wrongBearer.status, 401);
    const migrated = await fetch(`${first.baseUrl}/api/teams`, {
      headers: { cookie: `teamswarm_control=${first.service.controlToken}` },
    });
    assert.equal(migrated.status, 200);
    assert.equal(migrated.headers.get('set-cookie')?.split(';')[0], sessions[0]);
    const restartToken = first.service.controlToken;
    await first.close();
    const reopened = await listen(createApp({ dataDir: path.join(directory, 'first'), controlToken: restartToken }), path.join(directory, 'web'));
    try {
      const response = await fetch(`${reopened.baseUrl}/api/teams`, { headers: { cookie: sharedBrowserCookie } });
      assert.equal(response.status, 200);
    } finally {
      await reopened.close();
    }
  } finally {
    if (first.server.listening) await first.close();
    await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('serves durable Team records over HTTP with isolation and idempotency', async () => {
  const dataDir = await mkdtemp(path.join(process.cwd(), '.test-team-'));
  const webDistDir = path.join(dataDir, 'web-dist');
  await mkdir(webDistDir, { recursive: true });
  await writeFile(
    path.join(webDistDir, 'index.html'),
    '<!doctype html><html><body><div id="root">Team UI</div></body></html>',
    'utf8',
  );

  let running = await open(dataDir, webDistDir);
  try {
    const health = await request(running, '/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { ok: true, service: 'teamswarm', apiVersion: 1 });

    const empty = await request(running, '/api/teams');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { teams: [] });
    const staticPage = await request(running, '/');
    assert.equal(staticPage.status, 200);
    assert.match(staticPage.text, /Team UI/);
    const staticFallback = await request(running, '/workspace/overview');
    assert.equal(staticFallback.status, 200);
    assert.match(staticFallback.text, /Team UI/);

    const invalidName = await request(running, '/api/teams', {
      method: 'POST',
      body: JSON.stringify({ name: '   ' }),
    });
    assert.equal(invalidName.status, 400);
    assert.equal(invalidName.body.error.code, 'invalid_field');

    const blockedOrigin = await request(running, '/api/teams', {
      method: 'POST',
      headers: { origin: 'https://not-local.example' },
      body: JSON.stringify({ name: 'Blocked' }),
    });
    assert.equal(blockedOrigin.status, 403);
    assert.equal(blockedOrigin.body.error.code, 'origin_not_allowed');

    const created = await request(running, '/api/teams', {
      method: 'POST',
      body: JSON.stringify({ name: '  Alpha Team  ', purpose: '  local notes  ' }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'Alpha Team');
    assert.equal(created.body.purpose, 'local notes');
    assert.equal(created.body.isExample, false);
    const alphaId = created.body.id;

    const second = await request(running, '/api/teams', {
      method: 'POST',
      body: JSON.stringify({ name: 'Beta Team' }),
    });
    assert.equal(second.status, 201);
    const betaId = second.body.id;

    const invalidSettings = await request(running, `/api/teams/${alphaId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({
        providerName: '',
        baseUrl: 'file:///private',
        model: '',
        harness: 'unconfigured',
        memory: 'local',
      }),
    });
    assert.equal(invalidSettings.status, 400);
    assert.equal(invalidSettings.body.error.code, 'invalid_settings');

    const settings = await request(running, `/api/teams/${alphaId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({
        providerName: '  Local provider  ',
        baseUrl: 'https://example.test/v1',
        model: '  demo-model  ',
        harness: 'codex',
        memory: 'local',
      }),
    });
    assert.equal(settings.status, 200);
    assert.deepEqual(settings.body.settings, {
      providerName: 'Local provider',
      baseUrl: 'https://example.test/v1',
      model: 'demo-model',
      harness: 'codex',
      memory: 'local',
    });

    const project = await request(running, `/api/teams/${alphaId}/projects`, {
      method: 'POST',
      body: JSON.stringify({ title: '  First project  ', description: '  Keep it local  ' }),
    });
    assert.equal(project.status, 201);
    assert.equal(project.body.title, 'First project');
    assert.equal(project.body.description, 'Keep it local');
    const projectId = project.body.id;

    const conversation = await request(running, `/api/teams/${alphaId}/conversations`, {
      method: 'POST',
      body: JSON.stringify({ title: '  First conversation  ', projectId }),
    });
    assert.equal(conversation.status, 201);
    assert.equal(conversation.body.title, 'First conversation');
    const conversationId = conversation.body.id;

    const crossCreate = await request(running, `/api/teams/${betaId}/conversations`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Cross-team attempt', projectId }),
    });
    assert.equal(crossCreate.status, 404);

    const crossConversationRead = await request(
      running,
      `/api/teams/${betaId}/conversations/${conversationId}`,
    );
    assert.equal(crossConversationRead.status, 404);
    const crossProjectRead = await request(running, `/api/teams/${betaId}/projects/${projectId}`);
    assert.equal(crossProjectRead.status, 404);

    const blankMessage = await request(
      running,
      `/api/teams/${alphaId}/conversations/${conversationId}/messages`,
      { method: 'POST', body: JSON.stringify({ content: '   ', clientRequestId: 'req-blank' }) },
    );
    assert.equal(blankMessage.status, 400);

    const sent = await request(
      running,
      `/api/teams/${alphaId}/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ content: '  Hello local Team  ', clientRequestId: 'req-1' }),
      },
    );
    assert.equal(sent.status, 200);
    assert.equal(sent.body.message.content, 'Hello local Team');
    assert.equal(sent.body.message.role, 'user');
    assert.equal(sent.body.message.delivery, 'recorded');
    assert.equal(sent.body.runtime.status, 'not_connected');
    assert.equal(sent.body.conversation.title, 'First conversation');
    const messageId = sent.body.message.id;

    const duplicate = await request(
      running,
      `/api/teams/${alphaId}/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ content: 'Hello local Team', clientRequestId: 'req-1' }),
      },
    );
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.message.id, messageId);

    const conflictingDuplicate = await request(
      running,
      `/api/teams/${alphaId}/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ content: 'A different message', clientRequestId: 'req-1' }),
      },
    );
    assert.equal(conflictingDuplicate.status, 409);
    assert.equal(conflictingDuplicate.body.error.code, 'idempotency_conflict');

    const conversationDetail = await request(
      running,
      `/api/teams/${alphaId}/conversations/${conversationId}`,
    );
    assert.equal(conversationDetail.status, 200);
    assert.equal(conversationDetail.body.messages.length, 1);

    const example = await request(running, '/api/examples', { method: 'POST', body: '{}' });
    assert.equal(example.status, 201);
    assert.equal(example.body.team.isExample, true);
    assert.ok(example.body.conversations.length > 0);
    assert.ok(example.body.projects.length > 0);
    assert.ok(example.body.activities.every((activity: any) => activity.isExample));
    const exampleConversationId = example.body.conversations[0].id;
    const exampleConversation = await request(
      running,
      `/api/teams/${example.body.team.id}/conversations/${exampleConversationId}`,
    );
    assert.equal(exampleConversation.status, 200);
    assert.ok(exampleConversation.body.messages.every((message: any) => message.delivery === 'example'));

    const exampleProjectId = example.body.projects[0].id;
    const exampleProject = await request(
      running,
      `/api/teams/${example.body.team.id}/projects/${exampleProjectId}`,
    );
    assert.equal(exampleProject.status, 200);
    assert.equal(exampleProject.body.artifacts[0].isExample, true);
    assert.equal(exampleProject.body.artifacts[0].kind, 'markdown');
  } finally {
    await running.close();
  }

  // A new service instance reads the same SQLite file and does not rely on process memory.
  running = await open(dataDir, webDistDir);
  try {
    const afterRestart = await request(running, '/api/teams');
    assert.equal(afterRestart.status, 200);
    assert.equal(afterRestart.body.teams.length, 3);
    const alpha = afterRestart.body.teams.find((team: any) => team.name === 'Alpha Team');
    assert.ok(alpha);
    assert.equal(alpha.settings.model, 'demo-model');
    const detail = await request(running, `/api/teams/${alpha.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.conversations.length, 1);
    assert.equal(detail.body.projects.length, 1);
    assert.equal(detail.body.runtime.status, 'not_connected');
  } finally {
    await running.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
