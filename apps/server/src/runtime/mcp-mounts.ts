import { randomUUID } from "node:crypto";
import { Ajv } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { listMcpTools, localMcpUrl, mcpRequest, projectMcpResult, withMcpClient, type McpToolContract } from "./mcp-transport.js";
import { hash, type RuntimeStore } from "./store.js";
import type { Attempt, McpMount, Work } from "./types.js";

type McpService = { id: string; revision: number; name: string; url: string; tools: McpToolContract[] };
type McpGrant = McpMount & { active: boolean };

function canonicalArguments(args: Record<string, unknown>) {
  return JSON.stringify(args, (_key, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const fields = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(fields).sort().map(key => [key, fields[key]]));
  });
}

export class McpMounts {
  private readonly pending = new Map<AbortController, { teamId: string; serviceId: string; tool: string }>();
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(private store: RuntimeStore) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_mcp_services (id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_mcp_revisions (
        service_id TEXT NOT NULL REFERENCES runtime_mcp_services(id), revision INTEGER NOT NULL,
        data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(service_id,revision));
      CREATE TABLE IF NOT EXISTS runtime_mcp_grants (
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, service_id TEXT NOT NULL,
        tool TEXT NOT NULL, revision INTEGER NOT NULL, generation INTEGER NOT NULL, active INTEGER NOT NULL,
        PRIMARY KEY(team_id,service_id,tool),
        FOREIGN KEY(service_id,revision) REFERENCES runtime_mcp_revisions(service_id,revision));
    `);
    store.changes.track("runtime_mcp_grants", "mcp_grants", "team_id", true);
  }

  private current(id: string) {
    const row = this.store.db.prepare(`SELECT r.data FROM runtime_mcp_services s
      JOIN runtime_mcp_revisions r ON r.service_id=s.id AND r.revision=s.revision WHERE s.id=?`).get(id);
    return row ? JSON.parse(String(row.data)) as McpService : undefined;
  }

  private grant(teamId: string, serviceId: string, tool: string): McpGrant | undefined {
    const row = this.store.db.prepare("SELECT revision,generation,active FROM runtime_mcp_grants WHERE team_id=? AND service_id=? AND tool=?")
      .get(teamId, serviceId, tool);
    return row ? { serviceId, tool, revision: Number(row.revision), generation: Number(row.generation), active: Boolean(row.active) } : undefined;
  }

  list(teamId?: string) {
    if (teamId && !this.store.teams.getTeam(teamId)) throw notFound();
    const services = this.store.db.prepare(`SELECT r.data FROM runtime_mcp_services s
      JOIN runtime_mcp_revisions r ON r.service_id=s.id AND r.revision=s.revision ORDER BY s.rowid`)
      .all().map(row => JSON.parse(String(row.data)) as McpService);
    return services.map(service => ({ ...service, tools: service.tools.map(tool => ({ ...tool,
      ...(teamId ? { grant: this.grant(teamId, service.id, tool.name) } : {}),
    })) }));
  }

  async discover(input: { id?: string; expectedRevision: number; name: string; url: string }, signal?: AbortSignal) {
    const url = localMcpUrl(input.url).href;
    const id = input.id ?? randomUUID();
    const check = () => {
      const current = this.current(id);
      if (input.expectedRevision && !current) throw notFound();
      if ((current?.revision ?? 0) !== input.expectedRevision) throw conflict("mcp_revision", "Reload the current MCP service revision.");
      return current;
    };
    check();
    const tools = await withMcpClient(url, listMcpTools, signal);
    signal?.throwIfAborted();
    if (!tools.length) throw badRequest("mcp_tool_catalog", "The service has no eligible read-only tools.");
    for (const tool of tools) this.validator(tool);
    return this.store.transaction(() => {
      const current = check();
      if (current?.url === url && current.name === input.name && current.tools.length === tools.length &&
          current.tools.every((tool, i) => tool.digest === tools[i].digest)) return current;
      const service: McpService = { id, revision: input.expectedRevision + 1, name: input.name, url, tools };
      this.store.db.prepare("INSERT INTO runtime_mcp_services VALUES (?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision")
        .run(id, service.revision);
      this.store.db.prepare("INSERT INTO runtime_mcp_revisions VALUES (?,?,?)").run(id, service.revision, JSON.stringify(service));
      this.store.db.prepare("UPDATE runtime_mcp_grants SET generation=generation+1,active=0 WHERE service_id=? AND active=1").run(id);
      this.store.afterCommit(() => this.cancel(id));
      return service;
    });
  }

  changeGrant(teamId: string, input: Omit<McpGrant, "generation"> & { expectedGeneration: number }) {
    if (!this.store.teams.getTeam(teamId)) throw notFound();
    return this.store.transaction(() => {
      const service = this.current(input.serviceId);
      if (!service || service.revision !== input.revision || !service.tools.some(tool => tool.name === input.tool))
        throw conflict("mcp_revision", "Reload the current MCP tool catalog.");
      const current = this.grant(teamId, input.serviceId, input.tool);
      if ((current?.generation ?? 0) !== input.expectedGeneration) throw conflict("mcp_grant_changed", "Reload the current tool authorization.");
      if (current && current.active === input.active && current.revision === input.revision) return current;
      const next: McpGrant = { serviceId: service.id, revision: service.revision, tool: input.tool,
        generation: input.expectedGeneration + 1, active: input.active };
      this.store.db.prepare(`INSERT INTO runtime_mcp_grants VALUES(?,?,?,?,?,?) ON CONFLICT(team_id,service_id,tool)
        DO UPDATE SET revision=excluded.revision,generation=excluded.generation,active=excluded.active`)
        .run(teamId, next.serviceId, next.tool, next.revision, next.generation, Number(next.active));
      if (!next.active) this.store.afterCommit(() => this.cancel(next.serviceId, teamId, next.tool));
      this.store.event(teamId, next.active ? "mcp.granted" : "mcp.revoked", { ...next });
      return next;
    });
  }

  private cancel(serviceId: string, teamId?: string, tool?: string) {
    for (const [controller, scope] of this.pending)
      if (scope.serviceId === serviceId && (!teamId || scope.teamId === teamId) && (!tool || scope.tool === tool)) controller.abort();
  }

  private approved(teamId: string, mount: McpMount) {
    const grant = this.grant(teamId, mount.serviceId, mount.tool);
    if (!grant?.active || grant.revision !== mount.revision || grant.generation !== mount.generation)
      throw conflict("mcp_grant_required", "The MCP tool authorization changed.");
    const service = this.current(mount.serviceId);
    const tool = service?.tools.find(tool => tool.name === mount.tool);
    if (!service || service.revision !== mount.revision || !tool) throw conflict("mcp_revision", "The MCP tool revision changed.");
    return { service, tool };
  }

  private active(teamId: string, mount: McpMount) {
    const grant = this.grant(teamId, mount.serviceId, mount.tool);
    return grant?.active === true && grant.revision === mount.revision && grant.generation === mount.generation;
  }

  allowed(work: Work) {
    return (work.mcpMounts ?? []).every(mount => this.active(work.teamId, mount));
  }

  visible(teamId: string, mounts?: McpMount[]) {
    const candidates = mounts ?? this.store.db.prepare("SELECT service_id,tool,revision,generation FROM runtime_mcp_grants WHERE team_id=? AND active=1 ORDER BY service_id,tool")
      .all(teamId).map(row => ({ serviceId: String(row.service_id), tool: String(row.tool), revision: Number(row.revision), generation: Number(row.generation) }));
    return candidates.filter(mount => this.active(teamId, mount)).map(mount => {
      const { service, tool } = this.approved(teamId, mount);
      return { mount, service: service.name, description: tool.description };
    });
  }

  verify(teamId: string, mounts: McpMount[]) {
    for (const mount of mounts) this.approved(teamId, mount);
    return mounts;
  }

  detail(teamId: string, mount: McpMount) {
    const { tool } = this.approved(teamId, mount);
    return tool;
  }

  private validator(tool: McpToolContract) {
    const cached = this.validators.get(tool.digest);
    if (cached) return cached;
    try {
      const uri = String(tool.inputSchema.$schema ?? "");
      const Validator = /^https?:\/\/json-schema\.org\/draft-07\/schema#?$/.test(uri) ? Ajv
        : /^https?:\/\/json-schema\.org\/draft\/2019-09\/schema#?$/.test(uri) ? Ajv2019 : Ajv2020;
      const compiled = new Validator({ strict: false, validateFormats: false }).compile(tool.inputSchema);
      if (Reflect.get(compiled, "$async")) throw new Error("Asynchronous schema.");
      if (this.validators.size >= 128) this.validators.delete(this.validators.keys().next().value!);
      this.validators.set(tool.digest, compiled);
      return compiled;
    }
    catch { throw badRequest("mcp_schema", `Unsupported input schema for tool ${tool.name}.`); }
  }

  async invoke(work: Work, attempt: Pick<Attempt, "id" | "memberId">, callId: string,
    mount: McpMount, args: Record<string, unknown>, assertCurrent: () => void, signal?: AbortSignal) {
    const { service, tool } = this.approved(work.teamId, mount);
    const argumentsJson = canonicalArguments(args);
    if (Buffer.byteLength(argumentsJson) > 24000 || !this.validator(tool)(args))
      throw badRequest("mcp_tool_arguments", "The arguments do not match the approved MCP tool schema.");
    const cancellation = new AbortController();
    this.pending.set(cancellation, { teamId: work.teamId, serviceId: service.id, tool: tool.name });
    const live = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
    const verify = () => {
      if (cancellation.signal.aborted) throw conflict("mcp_grant_required", "The MCP tool authorization changed.");
      live.throwIfAborted();
      assertCurrent();
      this.approved(work.teamId, mount);
    };
    try {
      verify();
      const payload = await withMcpClient(service.url, async (client, limit) => {
        const observed = (await listMcpTools(client, limit)).find(item => item.name === tool.name);
        verify();
        if (observed?.digest !== tool.digest) throw conflict("mcp_schema_changed", "Refresh and authorize the updated MCP tool contract.");
        return projectMcpResult(await mcpRequest(limit, signal => client.callTool({ name: tool.name, arguments: args }, undefined, { signal })));
      }, live);
      verify();
      const receipt = this.store.event(work.teamId, "mcp.tool_completed", {
        ...mount, memberId: attempt.memberId, callId, argumentsSha256: hash(argumentsJson),
        schemaSha256: tool.digest, sha256: hash(JSON.stringify(payload)),
      }, work, attempt.id);
      return { ...payload, receipt };
    } catch (error) {
      verify();
      throw error;
    } finally {
      this.pending.delete(cancellation);
    }
  }
}
