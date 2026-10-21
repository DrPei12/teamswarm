import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  Activity,
  Artifact,
  Conversation,
  ConversationDetail,
  Message,
  Project,
  ProjectDetail,
  SendMessageResult,
  Team,
  TeamDetail,
  TeamSettings,
} from '@team/contracts';
import { conflict } from './errors.js';

type Row = Record<string, unknown>;
type SqlParameter = string | number | bigint | Uint8Array | null;

export const RUNTIME: SendMessageResult['runtime'] = {
  status: 'not_connected',
  message: '消息已记录；Team Agent 尚未连接，当前不会生成回复。',
};

const DEFAULT_SETTINGS: TeamSettings = {
  providerName: '',
  baseUrl: '',
  model: '',
  harness: 'unconfigured',
  memory: 'local',
};

function now(): string {
  return new Date().toISOString();
}

function id(): string {
  return randomUUID();
}

function value(row: Row, key: string): unknown {
  return row[key];
}

function text(row: Row, key: string): string {
  return String(value(row, key) ?? '');
}

function nullableText(row: Row, key: string): string | null {
  const item = value(row, key);
  return item === null || item === undefined ? null : String(item);
}

function booleanValue(row: Row, key: string): boolean {
  return Number(value(row, key) ?? 0) === 1;
}

function mapSettings(row: Row): TeamSettings {
  return {
    providerName: text(row, 'provider_name'),
    baseUrl: text(row, 'base_url'),
    model: text(row, 'model'),
    harness: text(row, 'harness') as TeamSettings['harness'],
    memory: 'local',
  };
}

function mapTeam(row: Row): Team {
  return {
    id: text(row, 'id'),
    name: text(row, 'name'),
    purpose: text(row, 'purpose'),
    isExample: booleanValue(row, 'is_example'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    settings: mapSettings(row),
  };
}

function mapConversation(row: Row): Conversation {
  return {
    id: text(row, 'id'),
    teamId: text(row, 'team_id'),
    title: text(row, 'title'),
    projectId: nullableText(row, 'project_id'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

function mapMessage(row: Row): Message {
  const clientRequestId = nullableText(row, 'client_request_id');
  const message: Message = {
    id: text(row, 'id'),
    conversationId: text(row, 'conversation_id'),
    role: text(row, 'role') as Message['role'],
    content: text(row, 'content'),
    createdAt: text(row, 'created_at'),
    delivery: text(row, 'delivery') as Message['delivery'],
  };
  if (clientRequestId !== null) message.clientRequestId = clientRequestId;
  return message;
}

function mapProject(row: Row): Project {
  return {
    id: text(row, 'id'),
    teamId: text(row, 'team_id'),
    title: text(row, 'title'),
    description: text(row, 'description'),
    status: text(row, 'status') as Project['status'],
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

function mapArtifact(row: Row): Artifact {
  return {
    id: text(row, 'id'),
    projectId: text(row, 'project_id'),
    title: text(row, 'title'),
    kind: text(row, 'kind') as Artifact['kind'],
    content: text(row, 'content'),
    createdAt: text(row, 'created_at'),
    isExample: booleanValue(row, 'is_example'),
  };
}

function mapActivity(row: Row): Activity {
  return {
    id: text(row, 'id'),
    teamId: text(row, 'team_id'),
    projectId: nullableText(row, 'project_id'),
    title: text(row, 'title'),
    detail: text(row, 'detail'),
    createdAt: text(row, 'created_at'),
    isExample: booleanValue(row, 'is_example'),
  };
}

export interface TeamStoreOptions {
  dataDir: string;
}

export interface RecordedMessage {
  message: Message;
  duplicate: boolean;
}

export class TeamStore {
  readonly dataDir: string;
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private closed = false;

  /** Runtime modules share this connection so state and journal updates are atomic. */
  get database(): DatabaseSync { return this.db; }

  constructor(options: TeamStoreOptions) {
    this.dataDir = path.resolve(options.dataDir);
    this.dbPath = path.join(this.dataDir, 'team.sqlite');
    mkdirSync(this.dataDir, { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        purpose TEXT NOT NULL DEFAULT '',
        is_example INTEGER NOT NULL DEFAULT 0 CHECK (is_example IN (0, 1)),
        provider_name TEXT NOT NULL DEFAULT '',
        base_url TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        harness TEXT NOT NULL DEFAULT 'unconfigured',
        memory TEXT NOT NULL DEFAULT 'local',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivery TEXT NOT NULL,
        client_request_id TEXT,
        UNIQUE (conversation_id, client_request_id)
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        is_example INTEGER NOT NULL DEFAULT 0 CHECK (is_example IN (0, 1))
      );

      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL,
        is_example INTEGER NOT NULL DEFAULT 0 CHECK (is_example IN (0, 1))
      );

      CREATE INDEX IF NOT EXISTS conversations_team_updated
        ON conversations(team_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS projects_team_updated
        ON projects(team_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS messages_conversation_created
        ON messages(conversation_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS activities_team_created
        ON activities(team_id, created_at DESC);
    `);
  }

  private all(sql: string, ...params: SqlParameter[]): Row[] {
    const statement = this.db.prepare(sql);
    return (statement.all as (...values: SqlParameter[]) => unknown[])(...params) as Row[];
  }

  private one(sql: string, ...params: SqlParameter[]): Row | undefined {
    const statement = this.db.prepare(sql);
    return (statement.get as (...values: SqlParameter[]) => unknown)(...params) as Row | undefined;
  }

  private run(sql: string, ...params: SqlParameter[]): void {
    const statement = this.db.prepare(sql);
    (statement.run as (...values: SqlParameter[]) => unknown)(...params);
  }

  private transaction<T>(callback: () => T): T {
    const savepoint = 'team_' + randomUUID().replaceAll('-', '');
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = callback();
      this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      try {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
      } catch {
        // Preserve the original failure if rollback itself cannot run.
      }
      throw error;
    }
  }

  private insertActivity(
    teamId: string,
    title: string,
    detail: string,
    projectId: string | null = null,
    isExample = false,
  ): void {
    this.run(
      `INSERT INTO activities
        (id, team_id, project_id, title, detail, created_at, is_example)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id(),
      teamId,
      projectId,
      title,
      detail,
      now(),
      isExample ? 1 : 0,
    );
  }

  private teamRow(teamId: string): Row | undefined {
    return this.one('SELECT * FROM teams WHERE id = ?', teamId);
  }

  private projectRow(teamId: string, projectId: string): Row | undefined {
    return this.one('SELECT * FROM projects WHERE id = ? AND team_id = ?', projectId, teamId);
  }

  private conversationRow(teamId: string, conversationId: string): Row | undefined {
    return this.one(
      'SELECT * FROM conversations WHERE id = ? AND team_id = ?',
      conversationId,
      teamId,
    );
  }

  listTeams(): Team[] {
    return this.all('SELECT * FROM teams ORDER BY created_at ASC').map(mapTeam);
  }

  getTeam(teamId: string): Team | undefined {
    const row = this.teamRow(teamId);
    return row ? mapTeam(row) : undefined;
  }

  getTeamDetail(teamId: string): TeamDetail | undefined {
    const teamRow = this.teamRow(teamId);
    if (!teamRow) return undefined;

    const conversations = this.all(
      'SELECT * FROM conversations WHERE team_id = ? ORDER BY updated_at DESC, created_at DESC',
      teamId,
    ).map(mapConversation);
    const projects = this.all(
      'SELECT * FROM projects WHERE team_id = ? ORDER BY updated_at DESC, created_at DESC',
      teamId,
    ).map(mapProject);
    const activities = this.all(
      'SELECT * FROM activities WHERE team_id = ? ORDER BY created_at DESC',
      teamId,
    ).map(mapActivity);

    return {
      team: mapTeam(teamRow),
      conversations,
      projects,
      activities,
      runtime: RUNTIME,
    };
  }

  createTeam(name: string, purpose: string): Team {
    const teamId = id();
    const timestamp = now();
    this.transaction(() => {
      this.run(
        `INSERT INTO teams
          (id, name, purpose, is_example, provider_name, base_url, model, harness, memory, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
        teamId,
        name,
        purpose,
        DEFAULT_SETTINGS.providerName,
        DEFAULT_SETTINGS.baseUrl,
        DEFAULT_SETTINGS.model,
        DEFAULT_SETTINGS.harness,
        DEFAULT_SETTINGS.memory,
        timestamp,
        timestamp,
      );
      this.insertActivity(teamId, 'Team 已创建', '本地工作区已准备；执行器尚未连接。');
    });
    return this.getTeam(teamId)!;
  }

  updateSettings(teamId: string, settings: TeamSettings): Team | undefined {
    if (!this.teamRow(teamId)) return undefined;
    const timestamp = now();
    this.transaction(() => {
      this.run(
        `UPDATE teams
            SET provider_name = ?, base_url = ?, model = ?, harness = ?, memory = ?, updated_at = ?
          WHERE id = ?`,
        settings.providerName,
        settings.baseUrl,
        settings.model,
        settings.harness,
        settings.memory,
        timestamp,
        teamId,
      );
      this.insertActivity(teamId, '配置已保存', '选择已记录；连接状态仍为未接通。');
    });
    return this.getTeam(teamId);
  }

  createConversation(teamId: string, title: string, projectId: string | null): Conversation | undefined {
    if (!this.teamRow(teamId)) return undefined;
    if (projectId !== null && !this.projectRow(teamId, projectId)) return undefined;

    const conversationId = id();
    const timestamp = now();
    this.transaction(() => {
      this.run(
        `INSERT INTO conversations (id, team_id, project_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        conversationId,
        teamId,
        projectId,
        title,
        timestamp,
        timestamp,
      );
      this.insertActivity(teamId, '对话已创建', title, projectId);
    });
    return mapConversation(this.one('SELECT * FROM conversations WHERE id = ?', conversationId)!);
  }

  getConversationDetail(teamId: string, conversationId: string, page?: { limit: number; before?: string }): (ConversationDetail & { historyBefore?: string }) | undefined {
    const conversation = this.conversationRow(teamId, conversationId);
    if (!conversation) return undefined;
    if (page) {
      const limit = Math.max(1, Math.min(100, page.limit));
      const cursor = page.before ? this.one('SELECT created_at, rowid AS seq FROM messages WHERE id=? AND conversation_id=?', page.before, conversationId) : undefined;
      if (page.before && !cursor) return undefined;
      const rows = cursor
        ? this.all('SELECT * FROM messages WHERE conversation_id=? AND (created_at < ? OR (created_at=? AND rowid < ?)) ORDER BY created_at DESC, rowid DESC LIMIT ?', conversationId, String(cursor.created_at), String(cursor.created_at), Number(cursor.seq), limit + 1)
        : this.all('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?', conversationId, limit + 1);
      const messages = rows.slice(0, limit).reverse().map(mapMessage);
      return { conversation: mapConversation(conversation), messages, ...(rows.length > limit ? { historyBefore: messages[0].id } : {}) };
    }
    const messages = this.all(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC',
      conversationId,
    ).map(mapMessage);
    return { conversation: mapConversation(conversation), messages };
  }

  createProject(teamId: string, title: string, description: string): Project | undefined {
    if (!this.teamRow(teamId)) return undefined;
    const projectId = id();
    const timestamp = now();
    this.transaction(() => {
      this.run(
        `INSERT INTO projects (id, team_id, title, description, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
        projectId,
        teamId,
        title,
        description,
        timestamp,
        timestamp,
      );
      this.insertActivity(teamId, '项目已创建', title, projectId);
    });
    return mapProject(this.one('SELECT * FROM projects WHERE id = ?', projectId)!);
  }

  getProjectDetail(teamId: string, projectId: string): ProjectDetail | undefined {
    const project = this.projectRow(teamId, projectId);
    if (!project) return undefined;
    const artifacts = this.all(
      'SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at ASC, rowid ASC',
      projectId,
    ).map(mapArtifact);
    return { project: mapProject(project), artifacts };
  }

  recordMessage(
    teamId: string,
    conversationId: string,
    content: string,
    clientRequestId: string,
    onRecorded?: (message: Message) => void,
  ): RecordedMessage | undefined {
    if (!this.conversationRow(teamId, conversationId)) return undefined;

    return this.transaction(() => {
      const existing = this.one(
        `SELECT * FROM messages
          WHERE conversation_id = ? AND client_request_id = ?`,
        conversationId,
        clientRequestId,
      );
      if (existing) {
        const existingMessage = mapMessage(existing);
        if (existingMessage.content !== content) {
          throw conflict(
            'idempotency_conflict',
            'clientRequestId 已用于另一条消息；请使用新的请求标识。',
          );
        }
        return { message: existingMessage, duplicate: true };
      }

      const messageId = id();
      const timestamp = now();
      this.run(
        `INSERT INTO messages
          (id, conversation_id, role, content, created_at, delivery, client_request_id)
         VALUES (?, ?, 'user', ?, ?, 'recorded', ?)`,
        messageId,
        conversationId,
        content,
        timestamp,
        clientRequestId,
      );
      this.run(
        'UPDATE conversations SET updated_at = ? WHERE id = ?',
        timestamp,
        conversationId,
      );
      // A readable first-message title makes history usable without requiring a model.
      // Only name a previously empty, default-titled conversation; keep custom titles intact.
      this.run(
        `UPDATE conversations SET title = ? WHERE id = ? AND title = '新的对话'
         AND (SELECT COUNT(*) FROM messages WHERE conversation_id = ?) = 1`,
        Array.from(content.split(/\r?\n/)[0]!.trim()).slice(0, 32).join(''),
        conversationId,
        conversationId,
      );
      this.insertActivity(
        teamId,
        '消息已记录',
        '本地服务已保存消息；Team Agent 尚未连接，未生成回复。',
        nullableText(this.conversationRow(teamId, conversationId)!, 'project_id'),
      );
      const message = mapMessage(this.one('SELECT * FROM messages WHERE id = ?', messageId)!);
      onRecorded?.(message);
      return { message, duplicate: false };
    });
  }

  createExample(): TeamDetail {
    const teamId = id();
    const projectId = id();
    const conversationId = id();
    const timestamp = now();
    const exampleName = '产品设计 · 示例';
    const projectTitle = 'Team 的第一版产品体验';
    const conversationTitle = '让协作从一段对话开始';

    this.transaction(() => {
      this.run(
        `INSERT INTO teams
          (id, name, purpose, is_example, provider_name, base_url, model, harness, memory, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        teamId,
        exampleName,
        '探索一种更自然的协作方式：从模糊想法开始，把目标逐渐变成计划和成果。',
        '示例配置',
        '',
        '示例模型（未连接）',
        'unconfigured',
        'local',
        timestamp,
        timestamp,
      );
      this.run(
        `INSERT INTO projects (id, team_id, title, description, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        projectId,
        teamId,
        projectTitle,
        '以对话为入口，连接目标、计划和成果。先把最重要的一条使用路径做清楚。',
        timestamp,
        timestamp,
      );
      this.run(
        `INSERT INTO conversations (id, team_id, project_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        conversationId,
        teamId,
        projectId,
        conversationTitle,
        timestamp,
        timestamp,
      );
      this.run(
        `INSERT INTO messages
          (id, conversation_id, role, content, created_at, delivery, client_request_id)
         VALUES (?, ?, 'user', ?, ?, 'example', NULL)`,
        id(),
        conversationId,
        '我想做一个能长期一起工作的 AI 团队。用户有时只有一个模糊的想法，不想先填一堆表格。第一版应该从哪里开始？',
        timestamp,
      );
      this.run(
        `INSERT INTO messages
          (id, conversation_id, role, content, created_at, delivery, client_request_id)
         VALUES (?, ?, 'assistant', ?, ?, 'example', NULL)`,
        id(),
        conversationId,
        '我会先围绕一个体验来做：**用户说出想法，Team 帮他找到值得推进的下一步。**\n\n开始时只需要对话。目标、边界和计划可以在讨论中逐渐清晰，不必在第一屏一次填完。\n\n### 一条尽量短的路径\n\n1. **说出想法** — 用户可以带着一个问题、一段描述，或者已有的工作开始。\n2. **一起理清方向** — Team 整理已知信息，指出真正需要用户判断的选择。\n3. **形成一个项目** — 当目标足够清晰，把计划和后续成果归到同一个地方。\n\n对话是入口，项目是持续工作的线索。界面需要让它们自然连接，同时保留随时返回讨论的空间。\n\n> 第一版的重点：让用户知道正在推进什么，也能轻松改变方向。',
        new Date(Date.parse(timestamp) + 1000).toISOString(),
      );
      this.run(
        `INSERT INTO artifacts (id, project_id, title, kind, content, created_at, is_example)
         VALUES (?, ?, ?, 'markdown', ?, ?, 1)`,
        id(),
        projectId,
        '第一版体验方向.md',
        `# 让协作从一段对话开始\n\n## 目标\n\n让带着模糊想法进入的用户，在自然对话中形成一个清晰、可调整的下一步。\n\n## 核心路径\n\n想法 → 澄清方向 → 项目计划 → 成果回看。\n\n- 对话始终是主要入口，保持连续阅读。\n- 项目负责组织长期工作，不要求用户一开始就创建。\n- 成果在需要时展开，保留返回讨论的路径。\n\n## 第一版关注什么\n\n| 时刻 | 用户需要知道 | 界面回应 |\n| --- | --- | --- |\n| 开始 | 我可以从哪里说起 | 一个清晰的输入位置 |\n| 讨论 | 方向是否被理解 | 有上下文的回应 |\n| 推进 | 下一步具体做什么 | 可调整的计划 |\n| 回看 | 这次得到了什么 | 可以打开的成果 |\n\n## 体验原则\n\n少一点预先配置，多一点自然开始。把空间留给内容，把控制权留给用户。`,
        new Date(Date.parse(timestamp) + 2000).toISOString(),
      );
      this.insertActivity(teamId, '示例项目已准备', '示例成果用于查看长内容和详情层次，不是执行证据。', projectId, true);
      this.insertActivity(teamId, '示例对话已准备', '示例消息带有 example 标记，与真实记录分开。', projectId, true);
    });

    return this.getTeamDetail(teamId)!;
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
