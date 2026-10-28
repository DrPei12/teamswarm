import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { TeamSettings } from '@team/contracts';
import { badRequest, ServiceError } from './errors.js';
import { TeamStore } from './store.js';
import { TeamRuntime } from './runtime/engine.js';
import { runtimeRoutes } from './runtime/routes.js';
import { productRoutes } from './product.js';
import type { Harness } from './runtime/types.js';

const DEFAULT_API_PORT = 4318;
const DEFAULT_WEB_PORT = 4317;
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const HARNESS_CHOICES = new Set(['unconfigured', 'codex', 'claude-code', 'grok', 'deepseek-harness', 'pi', 'opencode']);
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

export interface CreateAppOptions {
  controlToken?: string;
  dataDir?: string;
  webDistDir?: string;
  apiPort?: number;
  harnesses?: Harness[];
}

export interface TeamService {
  controlToken: string;
  app: Express;
  store: TeamStore;
  runtime: TeamRuntime;
  close: () => Promise<void>;
}

function projectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

function defaultDataDir(): string {
  return process.env.TEAM_DATA_DIR
    ? path.resolve(process.env.TEAM_DATA_DIR)
    : path.join(projectRoot(), '.local');
}

function defaultWebDistDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../teamswarm/dist');
}

function sendError(response: express.Response, error: ServiceError): void {
  response.status(error.status).json({ error: { code: error.code, message: error.message } });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest('invalid_json', '请求体必须是 JSON 对象。');
  }
  return value as Record<string, unknown>;
}

function requiredText(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
  label = field,
): string {
  const value = body[field];
  if (typeof value !== 'string') {
    throw badRequest('invalid_field', `${label}必须是字符串。`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw badRequest('invalid_field', `${label}不能为空。`);
  }
  if (trimmed.length > maxLength) {
    throw badRequest('invalid_field', `${label}不能超过 ${maxLength} 个字符。`);
  }
  return trimmed;
}

function optionalText(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
  defaultValue = '',
  label = field,
): string {
  if (!(field in body)) return defaultValue;
  const value = body[field];
  if (typeof value !== 'string') {
    throw badRequest('invalid_field', `${label}必须是字符串。`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw badRequest('invalid_field', `${label}不能超过 ${maxLength} 个字符。`);
  }
  return trimmed;
}

function parseSettings(body: Record<string, unknown>): TeamSettings {
  const requiredFields = ['providerName', 'baseUrl', 'model', 'harness', 'memory'];
  for (const field of requiredFields) {
    if (!(field in body)) {
      throw badRequest('invalid_settings', `设置缺少字段 ${field}。`);
    }
  }

  const providerName = requiredStringValue(body.providerName, 'providerName', 120);
  const baseUrl = requiredStringValue(body.baseUrl, 'baseUrl', 2000);
  const model = requiredStringValue(body.model, 'model', 200);
  const harness = requiredStringValue(body.harness, 'harness', 40);
  const memory = requiredStringValue(body.memory, 'memory', 20);

  if (!HARNESS_CHOICES.has(harness)) {
    throw badRequest('invalid_settings', 'harness 不是支持的选择。');
  }
  if (memory !== 'local') {
    throw badRequest('invalid_settings', 'memory 目前只能是 local。');
  }
  if (baseUrl !== '') {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw badRequest('invalid_settings', 'baseUrl 必须为空或合法的 http(s) URL。');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw badRequest('invalid_settings', 'baseUrl 必须为空或合法的 http(s) URL。');
    }
  }

  return { providerName, baseUrl, model, harness: harness as TeamSettings['harness'], memory: 'local' };
}

function requiredStringValue(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw badRequest('invalid_settings', `${field} 必须是字符串。`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw badRequest('invalid_settings', `${field} 不能超过 ${maxLength} 个字符。`);
  }
  return trimmed;
}

function routeParam(value: string | string[], field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest('invalid_path', `${field} 路径参数无效。`);
  }
  return value;
}

function isAllowedProductOrigin(origin: string, apiPort: number): boolean {
  try {
    const parsed = new URL(origin);
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'http:' ? 80 : 443;
    const allowedPorts = new Set([DEFAULT_WEB_PORT, DEFAULT_API_PORT, apiPort]);
    return (
      parsed.protocol === 'http:' &&
      LOCAL_HOSTNAMES.has(parsed.hostname) &&
      allowedPorts.has(port) &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

function safe(handler: RequestHandler): RequestHandler {
  return (request, response, next) => {
    try {
      return handler(request, response, next);
    } catch (error) {
      next(error);
    }
  };
}

export function createApp(options: CreateAppOptions = {}): TeamService {
  const controlToken = options.controlToken ?? randomBytes(32).toString('hex');
  if (!/^[a-zA-Z0-9_-]{32,128}$/.test(controlToken)) throw new Error('Control credentials require 32-128 URL-safe characters.');
  // Cookies share a host across ports. Each workspace needs a distinct session name.
  const controlCookie = `teamswarm_control_${createHash('sha256').update(controlToken).digest('hex').slice(0, 16)}`;
  const cookieOptions = { httpOnly: true, sameSite: 'strict' as const, path: '/api' };
  const apiPort = options.apiPort ?? DEFAULT_API_PORT;
  const store = new TeamStore({ dataDir: options.dataDir ?? defaultDataDir() });
  let runtime: TeamRuntime;
  try { runtime = new TeamRuntime(store, options.harnesses); } catch (error) { store.close(); throw error; }
  const app = express();
  const webDistDir = path.resolve(options.webDistDir ?? defaultWebDistDir());

  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.path.startsWith('/api/') && !LOCAL_HOSTNAMES.has(request.hostname)) {
      sendError(response, new ServiceError(403, 'host_not_allowed', 'Only a local product host is allowed.'));
      return;
    }
    if (
      request.path.startsWith('/api/') &&
      WRITE_METHODS.has(request.method) &&
      request.headers.origin &&
      !isAllowedProductOrigin(request.headers.origin, apiPort)
    ) {
      sendError(response, new ServiceError(403, 'origin_not_allowed', '只允许本地产品 Origin 写入。'));
      return;
    }
    next();
  });
  app.use(express.json({ limit: '16mb', strict: true }));

  // Browser/user capability is never included in model input or native child environments.
  app.use('/api', (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.path === '/health') { next(); return; }
    const bearer = request.headers.authorization?.replace(/^Bearer /, '');
    const cookies = request.headers.cookie?.split(';').map(v => v.trim()) ?? [];
    const scopedCookie = cookies.find(v => v.startsWith(`${controlCookie}=`))?.slice(controlCookie.length + 1);
    const legacyCookie = cookies.find(v => v.startsWith('teamswarm_control='))?.slice('teamswarm_control='.length);
    const cookie = scopedCookie ?? legacyCookie;
    const token = Buffer.from(bearer ?? cookie ?? '');
    const expected = Buffer.from(controlToken);
    if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
      sendError(response, new ServiceError(401, 'control_required', '请使用服务启动时提供的连接链接打开 TeamSwarm。'));
      return;
    }
    // Existing browser sessions and desktop launchers migrate on their first authenticated request.
    if (!bearer && scopedCookie === undefined && legacyCookie !== undefined) {
      response.cookie(controlCookie, controlToken, cookieOptions);
    }
    next();
  });
  app.post('/api/control/session', (_request, response) => {
    response.cookie(controlCookie, controlToken, cookieOptions);
    response.json({ connected: true });
  });

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true, service: 'teamswarm', apiVersion: 1 });
  });

  app.get('/api/teams', safe((_request, response) => {
    response.json({ teams: store.listTeams() });
  }));

  app.post('/api/teams', safe((request, response) => {
    const body = record(request.body);
    const team = store.createTeam(
      requiredText(body, 'name', 80, '名称'),
      optionalText(body, 'purpose', 2000, '', '用途'),
    );
    response.status(201).json(team);
  }));

  app.get('/api/teams/:teamId', safe((request, response) => {
    const detail = store.getTeamDetail(routeParam(request.params.teamId, 'teamId'));
    if (!detail) throw new ServiceError(404, 'not_found', '未找到请求的 Team。');
    response.json({ ...detail, runtime: runtime.summary(detail.team.id) });
  }));

  app.patch('/api/teams/:teamId/settings', safe((request, response) => {
    const settings = parseSettings(record(request.body));
    const team = store.updateSettings(routeParam(request.params.teamId, 'teamId'), settings);
    if (!team) throw new ServiceError(404, 'not_found', '未找到请求的 Team。');
    response.json(team);
  }));

  app.post('/api/teams/:teamId/conversations', safe((request, response) => {
    const body = record(request.body);
    const teamId = routeParam(request.params.teamId, 'teamId');
    const title = optionalText(body, 'title', 160, '新对话', '标题');
    if (title.length === 0) throw badRequest('invalid_field', '标题不能为空。');
    let projectId: string | null = null;
    if ('projectId' in body) {
      if (typeof body.projectId !== 'string' || body.projectId.trim().length === 0) {
        throw badRequest('invalid_field', 'projectId 必须是非空字符串。');
      }
      projectId = body.projectId.trim();
    }
    const conversation = store.createConversation(teamId, title, projectId);
    if (!conversation) throw new ServiceError(404, 'not_found', '未找到 Team 或所属项目。');
    response.status(201).json(conversation);
  }));

  app.get('/api/teams/:teamId/conversations/:conversationId', safe((request, response) => {
    const detail = store.getConversationDetail(
      routeParam(request.params.teamId, 'teamId'),
      routeParam(request.params.conversationId, 'conversationId'),
    );
    if (!detail) throw new ServiceError(404, 'not_found', '未找到请求的对话。');
    response.json(detail);
  }));

  app.post('/api/teams/:teamId/conversations/:conversationId/messages', safe((request, response) => {
    const body = record(request.body);
    const teamId = routeParam(request.params.teamId, 'teamId');
    const conversationId = routeParam(request.params.conversationId, 'conversationId');
    const content = requiredText(body, 'content', 20000, '消息');
    const clientRequestId = requiredText(body, 'clientRequestId', 200, 'clientRequestId');
    const result = store.recordMessage(
      teamId,
      conversationId,
      content,
      clientRequestId,
      message => { if (runtime.store.settings(teamId)) runtime.store.enqueueHost(teamId, conversationId, message.id, true); },
    );
    if (!result) throw new ServiceError(404, 'not_found', '未找到请求的对话。');
    const alreadyQueued = runtime.store.list<import('./runtime/types.js').Run>('runs', teamId).some(run => run.sourceMessageId === result.message.id);
    const work = runtime.store.settings(teamId) && (!result.duplicate || alreadyQueued) ? runtime.enqueue(teamId, conversationId, result.message.id) : undefined;
    response.json({ message: result.message, conversation: store.getConversationDetail(teamId, conversationId)!.conversation, runtime: runtime.summary(teamId), ...(work ? { workId: work.id } : {}) });
  }));

  app.post('/api/teams/:teamId/projects', safe((request, response) => {
    const body = record(request.body);
    const teamId = routeParam(request.params.teamId, 'teamId');
    const title = requiredText(body, 'title', 160, '标题');
    const description = optionalText(body, 'description', 2000, '', '描述');
    const project = store.createProject(teamId, title, description);
    if (!project) throw new ServiceError(404, 'not_found', '未找到请求的 Team。');
    response.status(201).json(project);
  }));

  app.get('/api/teams/:teamId/projects/:projectId', safe((request, response) => {
    const detail = store.getProjectDetail(
      routeParam(request.params.teamId, 'teamId'),
      routeParam(request.params.projectId, 'projectId'),
    );
    if (!detail) throw new ServiceError(404, 'not_found', '未找到请求的项目。');
    response.json(detail);
  }));

  app.post('/api/examples', safe((_request, response) => {
    response.status(201).json(store.createExample());
  }));

  app.use('/api', runtimeRoutes(runtime));
  app.use('/api', productRoutes(runtime));

  app.use('/api', (_request, response) => {
    sendError(response, new ServiceError(404, 'not_found', '未找到请求的 API。'));
  });

  if (fs.existsSync(webDistDir)) {
    app.use(express.static(webDistDir, {
      index: 'index.html',
      fallthrough: true,
      setHeaders(response, file) {
        if (path.basename(file) === 'index.html') response.setHeader('Cache-Control', 'no-cache');
      },
    }));
    app.use(['/assets', '/fonts'], (_request, response) => {
      response.status(404).type('text/plain').send('Resource not found.');
    });
    app.get(/.*/, (_request, response) => {
      const indexPath = path.join(webDistDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        response.setHeader('Cache-Control', 'no-cache');
        response.type('html').send(fs.readFileSync(indexPath, 'utf8'));
      } else {
        response.status(404).type('text/plain').send('Web build does not contain index.html.');
      }
    });
  } else {
    app.get(/.*/, (_request, response) => {
      response.status(404).type('text/plain').send('Web build is not available.');
    });
  }

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof ServiceError) {
      sendError(response, error);
      return;
    }
    if (error instanceof SyntaxError) {
      sendError(response, new ServiceError(400, 'invalid_json', '请求体不是合法 JSON。'));
      return;
    }
    sendError(response, new ServiceError(500, 'internal_error', '服务处理请求时发生错误。'));
  };
  app.use(errorHandler);

  let closing: Promise<void> | undefined;
  return {
    controlToken,
    app,
    store,
    runtime,
    close: () => closing ??= (async () => { await runtime.close(); store.close(); })(),
  };
}
