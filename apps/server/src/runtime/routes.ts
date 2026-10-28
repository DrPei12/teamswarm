import { applicationDataBase } from "../../../../scripts/platform.cjs";
import { Router } from "express";
import path from "node:path";
import { z } from "zod";
import { badRequest, conflict, notFound } from "../errors.js";
import { TeamRuntime } from "./engine.js";
import { HarnessManagement } from "./harness/management.js";
import { supportsSubscription, subscriptionAccounts } from "./harness/subscriptions.js";
import { homedir } from "node:os";
import { resourceInput, directoryQuery, directoryDetail } from "./catalog.js";
import { capabilitiesInput } from "./capabilities.js";
import { allocationRequest, resourceSelection } from "./allocation-contract.js";
import {
  attemptAllocation,
  createResource,
  deleteResource,
  exportAllocationPackage,
  importAllocationPackage,
  listResources,
  memberAllocation,
  previewAllocationImport,
  resourceCreateInput,
  setMemberAllocation,
  setHostAllocation,
  setWorkAllocation,
} from "./allocation.js";
import { definitionInput, selectionInput } from "./project-history.js";
import { key, memberInput, parse, runtimeSettings, executionRequirements } from "./validation.js";
import type {
  ArtifactVersion,
  Attempt,
  Member,
  Run,
  Work,
  TeamExchange,
  HostDelivery,
} from "./types.js";
import {
  importConnection,
  modelConnection,
  resolveConnection,
  credentialReference,
} from "./connections.js";

export function runtimeRoutes(runtime: TeamRuntime): Router {
  const router = Router();
  const store = runtime.store;
  router.get("/teams/:teamId/runtime-resources", (req,res) => {
    const teamId = param(req.params.teamId);
    if (!store.teams.getTeam(teamId)) throw notFound();
    res.json(runtime.resources.state(teamId));
  });
  router.get("/teams/:teamId/capabilities", (req,res)=>res.json(runtime.catalog.capabilities.read(param(req.params.teamId))));
  router.put("/teams/:teamId/capabilities", (req,res)=>res.json(runtime.catalog.capabilities.save(param(req.params.teamId),parse(capabilitiesInput,req.body))));
  router.post("/teams/:teamId/model-catalog", async (req,res)=>{
    if(!store.teams.getTeam(param(req.params.teamId))) throw notFound();
    const input=parse(z.object({endpoints:modelConnection.shape.endpoints,credentialEnv:credentialReference}).strict(),req.body);
    const entry=Object.entries(input.endpoints)[0];
    const secret=process.env[input.credentialEnv];
    if(!secret) throw badRequest("missing_credentials","Add an API key before loading models.");
    let url=entry[1]!.replace(/\/$/,"");
    if(entry[0]==="anthropic-messages"&&!url.endsWith("/v1"))url+="/v1";
    try {
      const response=await fetch(url+"/models",{headers:entry[0]==="anthropic-messages"?{"x-api-key":secret,"anthropic-version":"2023-06-01"}:{authorization:`Bearer ${secret}`},redirect:"error",signal:AbortSignal.timeout(20000)});
      if(!response.ok) throw new Error("catalog unavailable");
      const reader=response.body!.getReader(); let body="",bytes=0;const decoder=new TextDecoder();
      for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>2_000_000){await reader.cancel();throw new Error("catalog too large");}body+=decoder.decode(part.value,{stream:true});}
      body+=decoder.decode();
      const data=JSON.parse(body);
      const rows=Array.isArray(data.data)?data.data:Array.isArray(data.models)?data.models:[];
      const models=[...new Set(rows.flatMap((m:any)=>typeof m.id==="string"&&m.id.length<=200?[m.id]:[]))].slice(0,1000);
      res.json({models});
    } catch {throw badRequest("model_catalog_unavailable","Could not load the model list. Check the address and API key, or enter a model ID.");}
  });
  const harnessManagement = new HarnessManagement(path.join(applicationDataBase(), "TeamSwarm", "installer"), () => store.teams.listTeams().flatMap(team => { const settings = store.settings(team.id); return settings ? [settings.workspace] : []; }));
  router.put("/teams/:teamId/resources/:resourceId", (req, res) => {
    const input = parse(resourceInput, req.body);
    if (!runtime.harnesses.has(input.config.harness))
      throw badRequest(
        "unsupported_harness",
        "No installed adapter for this resource.",
      );
    runtime.validateConfig(input.config);
    res.json(
      runtime.catalog.put(
        param(req.params.teamId),
        param(req.params.resourceId),
        input,
      ),
    );
  });

  const allocationDeps = () => ({
    store: runtime.store,
    catalog: runtime.catalog,
  });
  router.get("/teams/:teamId/resources", (req, res) => {
    const teamId = param(req.params.teamId);
    const resources = listResources(allocationDeps(),teamId);
    res.json({
      resources: req.query.enabled === "true" ? resources.filter(r=>runtime.catalog.capabilities.allowed(teamId,r.config)) : resources,
    });
  });
  router.get("/teams/:teamId/branches/:branchId/host-allocation", (req, res) => {
    const teamId = param(req.params.teamId), branchId = param(req.params.branchId);
    runtime.history.branch(teamId, branchId);
    const host = store.list<Member>("members", teamId).find(m => m.kind === "host");
    if (!host) throw notFound();
    res.json(runtime.catalog.memberExecution(teamId, branchId, host));
  });
  router.put("/teams/:teamId/branches/:branchId/host-allocation", (req, res) => {
    const teamId = param(req.params.teamId), branchId = param(req.params.branchId);
    const input = parse(z.object({expectedRevision: z.number().int().positive(), selection: resourceSelection.nullable()}).strict(), req.body);
    if (input.selection) runtime.validateConfig(runtime.catalog.resource(teamId, input.selection.resourceId).config);
    res.json(setHostAllocation(allocationDeps(), teamId, branchId, input.expectedRevision, input.selection));
  });
  router.post("/teams/:teamId/resources", (req, res) => {
    const input = parse(resourceCreateInput, req.body);
    if (!runtime.harnesses.has(input.config.harness))
      throw badRequest(
        "unsupported_harness",
        "No installed adapter for this resource.",
      );
    runtime.validateConfig(input.config);
    res
      .status(201)
      .json(createResource(allocationDeps(), param(req.params.teamId), input));
  });
  router.delete("/teams/:teamId/resources/:resourceId", (req, res) => {
    res.json(
      deleteResource(
        allocationDeps(),
        param(req.params.teamId),
        param(req.params.resourceId),
      ),
    );
  });
  router.get("/teams/:teamId/members/:memberId/allocation", (req, res) => {
    res.json(
      memberAllocation(
        allocationDeps(),
        param(req.params.teamId),
        param(req.params.memberId),
      ),
    );
  });
  router.put("/teams/:teamId/members/:memberId/allocation", (req, res) => {
    const input = parse(allocationRequest, req.body);
    res.json(
      setMemberAllocation(
        allocationDeps(),
        param(req.params.teamId),
        param(req.params.memberId),
        input,
      ),
    );
  });
  router.put("/teams/:teamId/works/:workId/allocation", (req, res) => {
    const input = parse(allocationRequest, req.body);
    res.json(
      setWorkAllocation(
        allocationDeps(),
        param(req.params.teamId),
        param(req.params.workId),
        input,
      ),
    );
  });
  const packageInput = z.object({ package: z.unknown() });
  router.get("/teams/:teamId/allocation-package", (req, res) => {
    res.json(
      exportAllocationPackage(allocationDeps(), param(req.params.teamId)),
    );
  });
  router.post("/teams/:teamId/allocation-package/preview", (req, res) => {
    const input = parse(packageInput, req.body);
    res.json(
      previewAllocationImport(
        allocationDeps(),
        param(req.params.teamId),
        input.package,
      ),
    );
  });
  router.post("/teams/:teamId/allocation-package/import", (req, res) => {
    const input = parse(packageInput, req.body);
    res.json(
      importAllocationPackage(
        allocationDeps(),
        param(req.params.teamId),
        input.package,
      ),
    );
  });
  router.get("/teams/:teamId/branches/:branchId/directory", (req, res) => {
    const input = parse(directoryQuery, {
      ...req.query,
      ...(req.query.offset !== undefined
        ? { offset: Number(req.query.offset) }
        : {}),
      ...(req.query.limit !== undefined
        ? { limit: Number(req.query.limit) }
        : {}),
    });
    res.json(
      runtime.catalog.list(
        param(req.params.teamId),
        param(req.params.branchId),
        input,
      ),
    );
  });
  router.get(
    "/teams/:teamId/branches/:branchId/directory/detail",
    (req, res) => {
      res.json(
        runtime.catalog.detail(
          param(req.params.teamId),
          param(req.params.branchId),
          parse(directoryDetail, req.query),
        ),
      );
    },
  );
  router.get("/teams/:teamId/host-context/:attemptId", (req, res) => {
    res.json(
      runtime.hostContext.frame(
        param(req.params.teamId),
        param(req.params.attemptId),
      ),
    );
  });
  router.get("/teams/:teamId/branches/:branchId/host-context", (req, res) => {
    const teamId = param(req.params.teamId),
      branchId = param(req.params.branchId);
    res.json({
      version: runtime.hostContext.epoch(teamId, branchId),
      notes: runtime.hostContext.notes(teamId, branchId),
    });
  });
  router.post(
    "/teams/:teamId/branches/:branchId/host-context/reset",
    (req, res) => {
      const input = parse(
        z.object({ expectedVersion: z.number().int().min(0) }).strict(),
        req.body,
      );
      res.json(
        runtime.hostContext.reset(
          param(req.params.teamId),
          param(req.params.branchId),
          input.expectedVersion,
        ),
      );
    },
  );
  router.get("/teams/:teamId/branches/:branchId/views", (req, res) => {
    const teamId = param(req.params.teamId),
      branchId = param(req.params.branchId);
    res.json(
      store.transaction(() => {
        const branch = runtime.history.branch(teamId, branchId);
        const runs = store
          .list<Run>("runs", teamId)
          .filter((r) => runtime.history.forRun(r).id === branchId);
        const runIds = new Set(runs.map((r) => r.id));
        const works = store
          .list<Work>("works", teamId)
          .filter((w) => runIds.has(w.runId));
        const nodes = store.db
          .prepare(
            "SELECT data FROM project_nodes WHERE team_id = ? AND json_extract(data, '$.branchId') = ? ORDER BY rowid",
          )
          .all(teamId, branchId)
          .map((row) => JSON.parse(String(row.data)));
        const exchanges = runtime.communication.exchanges(teamId, branchId);
        const cursor = Number(
          store.db
            .prepare(
              "SELECT max(sequence) AS sequence FROM runtime_events WHERE team_id = ?",
            )
            .get(teamId)?.sequence ?? 0,
        );
        const discussionSources = [
          ...new Set<string>(
            nodes.flatMap((n) => n.source.exchangeMessageIds ?? []),
          ),
        ].map((id) => {
          const message = store.get<any>("exchange_messages", teamId, id);
          return {
            messageId: id,
            exchangeId: message.exchangeId,
            sequence: message.sequence,
            workId: message.workId,
            contextNodeId: message.contextNodeId,
          };
        });
        return {
          cursor,
          branch,
          project: runtime.history.context(teamId, branchId),
          collaboration: {
            members: store
              .list<Member>("members", teamId)
              .filter(
                (m) =>
                  m.kind === "host" ||
                  (m.branchId ?? runtime.history.ensure(teamId).id) ===
                    branchId,
              ),
            works,
            exchanges: exchanges.map((e) => ({
              ...e,
              read: {
                initiator: runtime.communication.seen(e, e.initiatorId),
                recipient: runtime.communication.seen(e, e.recipientId),
              },
              latestMessage: runtime.communication.messages(e).at(-1),
            })),
          },
          history: {
            nodes,
            runs,
            discussionSources,
            workIds: works.map((w) => w.id),
            exchanges: exchanges.map((e) => ({
              id: e.id,
              originWorkId: e.originWorkId,
              topic: e.topic,
            })),
          },
          deliveries: store
            .list<HostDelivery>("deliveries", teamId)
            .filter((d) => d.branchId === branchId),
        };
      }),
    );
  });
  router.get("/teams/:teamId/exchanges/:exchangeId", (req, res) => {
    const exchange = store.get<TeamExchange>(
      "exchanges",
      param(req.params.teamId),
      param(req.params.exchangeId),
    );
    res.json({ exchange, messages: runtime.communication.messages(exchange) });
  });
  router.post("/teams/:teamId/deliveries/:deliveryId/release", (req, res) => {
    const body = parse(
      z.object({ clientRequestId: key, expectedContextVersion: key }).strict(),
      req.body,
    );
    const teamId = param(req.params.teamId),
      deliveryId = param(req.params.deliveryId);
    res.json(
      store.once(
        `delivery:${teamId}:${deliveryId}`,
        body.clientRequestId,
        body,
        () =>
          runtime.communication.deliver(
            teamId,
            deliveryId,
            body.expectedContextVersion,
          ),
      ),
    );
  });
  router.post("/connections/import", (req, res) => {
    const input = parse(
      z
        .object({
          format: z.enum([
            "codex",
            "claude-code",
            "pi",
            "deepseek-harness",
            "opencode",
          ]),
          content: z.string().min(1).max(200000),
          credentialEnv: credentialReference,
        })
        .strict(),
      req.body,
    );
    res.json(
      importConnection(input.format, input.content, input.credentialEnv),
    );
  });
  router.post("/connections/resolve", (req, res) => {
    const input = parse(
      z
        .object({
          connection: modelConnection,
          harness: z.string().min(1).max(64),
          model: z.string().min(1).max(200),
          access: z.enum(["read-only", "workspace-write"]),
        })
        .strict(),
      req.body,
    );
    res.json(
      resolveConnection(
        input.connection,
        input.harness,
        input.model,
        input.access,
      ),
    );
  });
  const param = (value: unknown) => parse(key, value);
  const cursor = (value: unknown) =>
    parse(
      z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      value ?? 0,
    );
  router.get("/teams/:teamId/branches", (req, res) =>
    res.json({ branches: runtime.history.branches(param(req.params.teamId)) }),
  );
  router.get(
    "/teams/:teamId/conversations/:conversationId/branch",
    (req, res) =>
      res.json(
        runtime.history.forConversation(
          param(req.params.teamId),
          param(req.params.conversationId),
        ),
      ),
  );
  router.get("/teams/:teamId/branches/:branchId/context", (req, res) =>
    res.json(
      runtime.history.context(
        param(req.params.teamId),
        param(req.params.branchId),
      ),
    ),
  );
  router.get("/teams/:teamId/branches/:branchId/document", (req, res) => {
    const context = runtime.history.context(
      param(req.params.teamId),
      param(req.params.branchId),
    );
    const document = context.documents.find(
      (d) => d.key === param(req.query.key),
    );
    if (!document) throw notFound();
    res.setHeader("X-Document-Revision", document.id);
    res.type("text/markdown").send(document.content);
  });
  router.get("/teams/:teamId/branches/:branchId/sync", (req, res) =>
    res.json({
      attempts: runtime.history.syncState(
        param(req.params.teamId),
        param(req.params.branchId),
      ),
    }),
  );
  router.get("/teams/:teamId/history", (req, res) =>
    res.json(
      runtime.history.timeline(
        param(req.params.teamId),
        cursor(req.query.after),
        parse(z.coerce.number().int().min(1).max(500), req.query.limit ?? 100),
      ),
    ),
  );
  router.get("/teams/:teamId/history/:nodeId", (req, res) =>
    res.json(
      runtime.history.detail(
        param(req.params.teamId),
        param(req.params.nodeId),
      ),
    ),
  );
  router.post("/teams/:teamId/branches/:branchId/definitions", (req, res) => {
    const teamId = param(req.params.teamId),
      branchId = param(req.params.branchId);
    const body = parse(
      z.object({ clientRequestId: key, definition: definitionInput }).strict(),
      req.body,
    );
    res.json(
      store.once(
        `definition:${teamId}:${branchId}`,
        body.clientRequestId,
        body,
        () =>
          runtime.history.publish(teamId, branchId, body.definition, {
            actor: "user",
          }),
      ),
    );
  });
  router.post("/teams/:teamId/branches/:branchId/checkpoints", (req, res) => {
    const teamId = param(req.params.teamId),
      branchId = param(req.params.branchId);
    const body = parse(
      z
        .object({
          clientRequestId: key,
          expectedHeadId: key,
          title: z.string().trim().min(1).max(160),
        })
        .strict(),
      req.body,
    );
    res.json(
      store.once(
        `checkpoint:${teamId}:${branchId}`,
        body.clientRequestId,
        body,
        () =>
          runtime.history.checkpoint(
            teamId,
            branchId,
            body.expectedHeadId,
            body.title,
          ),
      ),
    );
  });
  router.post("/teams/:teamId/branches/:branchId/selections", (req, res) => {
    const teamId = param(req.params.teamId),
      branchId = param(req.params.branchId);
    const body = parse(
      z
        .object({
          clientRequestId: key,
          expectedHeadId: key,
          title: z.string().trim().min(1).max(160),
          selections: z.array(selectionInput).min(1).max(30),
        })
        .strict(),
      req.body,
    );
    res.json(
      store.once(
        `selection:${teamId}:${branchId}`,
        body.clientRequestId,
        body,
        () =>
          runtime.history.select(
            teamId,
            branchId,
            body.expectedHeadId,
            body.selections,
            body.title,
          ),
      ),
    );
  });
  router.post("/teams/:teamId/branches", (req, res) => {
    const teamId = param(req.params.teamId);
    const body = parse(
      z
        .object({
          clientRequestId: key,
          fromNodeId: key,
          name: z.string().trim().min(1).max(160),
          selections: z.array(selectionInput).max(30).default([]),
        })
        .strict(),
      req.body,
    );
    res
      .status(201)
      .json(
        store.once(`fork:${teamId}`, body.clientRequestId, body, () =>
          runtime.history.fork(
            teamId,
            body.fromNodeId,
            body.name,
            body.selections,
          ),
        ),
      );
  });
  router.get("/harnesses", (_req, res) =>
    res.json({
      harnesses: [...runtime.harnesses.values()].map((h) => ({
        id: h.id,
        capabilities: h.capabilities,
      })),
    }),
  );
  router.post("/harnesses/:harnessId/check", async (req, res) => {
    const harness = runtime.harnesses.get(param(req.params.harnessId));
    if (!harness) throw notFound();
    res.json(
      runtime.catalog.observeHarness(harness.id, await harness.inspect()),
    );
  });
  router.get("/harnesses/:harnessId/installation", async (req, res) => {
    res.json(await harnessManagement.status(param(req.params.harnessId), req.query.updates !== "false", req.query.refresh === "true"));
  });
  router.post("/harnesses/:harnessId/install", async (req, res) => {
    parse(z.object({}).strict(), req.body);
    res.status(202).json(await harnessManagement.install(param(req.params.harnessId)));
  });
  // POST requires the local control token, including reads of temporary login
  // URLs/codes. These must never be cached or put in the public runtime catalog.
  router.post("/harnesses/:harnessId/subscription/:action", async (req, res) => {
    const id = param(req.params.harnessId);
    if (!supportsSubscription(id)) throw notFound();
    res.setHeader("Cache-Control", "no-store");
    const action = param(req.params.action);
    if (action === "status" || action === "check-model") {
      const input = parse(z.object({ model: z.string().trim().min(1).max(200).nullable().default(null) }).strict(), req.body);
      return res.json(action === "status" ? await subscriptionAccounts.status(id, input.model) : await subscriptionAccounts.checkModel(id, input.model));
    }
    if (action === "start" || action === "poll") {
      parse(z.object({}).strict(), req.body);
      return res.json(action === "start" ? await subscriptionAccounts.start(id) : subscriptionAccounts.login(id));
    }
    if (action === "cancel") {
      const input = parse(z.object({ loginId: z.string().uuid() }).strict(), req.body);
      return res.json(await subscriptionAccounts.cancel(id, input.loginId));
    }
    if (action === "code") {
      const input = parse(z.object({ loginId: z.string().uuid(), code: z.string().min(1).max(4096) }).strict(), req.body);
      return res.json(subscriptionAccounts.submitCode(id, input.loginId, input.code));
    }
    throw notFound();
  });
  router.get("/teams/:teamId/runtime", (req, res) =>
    res.json(runtime.state(param(req.params.teamId))),
  );
  router.put("/teams/:teamId/runtime", (req, res) => {
    const input = parse(runtimeSettings, req.body);
    if (!path.isAbsolute(input.workspace))
      throw badRequest(
        "invalid_workspace",
        "Select an absolute workspace directory.",
      );
    runtime.validateConfig(input.config);
    const { expectedVersion, ...settings } = input;
    res.json(
      store.configure(param(req.params.teamId), settings, expectedVersion),
    );
  });
  router.post("/teams/:teamId/members", (req, res) => {
    const input = parse(memberInput.extend({ clientRequestId: key }), req.body);
    const teamId = param(req.params.teamId);
    runtime.validateConfig(input.config);
    res
      .status(201)
      .json(
        store.once(`member:${teamId}`, input.clientRequestId, input, () =>
          store.createMember(
            teamId,
            input.name,
            input.responsibility,
            input.config,
          ),
        ),
      );
  });
  router.patch("/teams/:teamId/members/:memberId", (req, res) => {
    const teamId = param(req.params.teamId);
    const input = parse(memberInput, req.body);
    runtime.validateConfig(input.config);
    const member = store.get<Member>(
      "members",
      teamId,
      param(req.params.memberId),
    );
    if (member.kind === "host")
      throw badRequest(
        "host_configuration",
        "Change Host configuration through Team runtime settings.",
      );
    if (
      store
        .list<Work>("works", teamId)
        .some(
          (w) =>
            w.memberId === member.id &&
            [
              "queued",
              "waiting",
              "running",
              "stopping",
              "recovery_required",
            ].includes(w.status),
        )
    )
      throw conflict(
        "member_busy",
        "Finish or stop this member’s current work before changing its configuration.",
      );
    store.transaction(() => {
      Object.assign(member, input);
      store.save("members", member);
      store.event(teamId, "member.updated", { memberId: member.id });
    });
    res.json(member);
  });
  router.get("/teams/:teamId/works/:workId", (req, res) => {
    const teamId = param(req.params.teamId),
      work = store.get<Work>("works", teamId, param(req.params.workId));
    res.json({
      work,
      attempts: store
        .list<Attempt>("attempts", teamId)
        .filter((a) => a.workId === work.id)
        .map((a) => ({ ...a, allocation: attemptAllocation(a) })),
      artifacts: store
        .currentArtifacts(work)
        .map(({ content: _content, ...rest }) => rest),
    });
  });
  router.post("/teams/:teamId/works/:workId/stop", async (req, res) =>
    res.json(
      await runtime.stop(param(req.params.teamId), param(req.params.workId)),
    ),
  );
  router.post("/teams/:teamId/works/:workId/reconcile", async (req, res) =>
    res.json(
      await runtime.reconcile(
        param(req.params.teamId),
        param(req.params.workId),
      ),
    ),
  );
  router.post("/teams/:teamId/works/:workId/retry", (req, res) => {
    const input = parse(
      z.object({ expectedRevision: z.number().int().positive() }).strict(),
      req.body,
    );
    res.json(
      runtime.retry(
        param(req.params.teamId),
        param(req.params.workId),
        input.expectedRevision,
      ),
    );
  });
  router.post("/teams/:teamId/works/:workId/review", (req, res) => {
    const input = parse(z.object({
      clientRequestId: z.string().uuid(),
      expectedRevision: z.number().int().positive(),
      reviewerMemberId: key,
      instructions: z.string().trim().min(1).max(20000),
      executionRequirements: executionRequirements.optional(),
    }).strict(), req.body);
    res.json(runtime.requestReview(param(req.params.teamId), param(req.params.workId), input));
  });
  router.post("/teams/:teamId/runs/:runId/pause", async (req, res) => {
    const teamId = param(req.params.teamId),
      run = store.get<Run>("runs", teamId, param(req.params.runId));
    if (!["active", "paused"].includes(run.state))
      throw conflict("invalid_state", "Only active work can be paused.");
    if (run.state !== "paused")
      store.transaction(() => {
        run.pausedWorkIds = store
          .list<Work>("works", teamId)
          .filter(
            (w) =>
              w.runId === run.id &&
              ["queued", "waiting", "running"].includes(w.status),
          )
          .map((w) => w.id);
        run.state = "paused";
        store.save("runs", run);
        store.event(teamId, "run.paused", {
          runId: run.id,
          workIds: run.pausedWorkIds,
        });
      });
    await Promise.all(
      (run.pausedWorkIds ?? []).map((id) =>
        runtime.stop(teamId, id, "Paused with the run."),
      ),
    );
    res.json(runtime.state(teamId));
  });
  router.post("/teams/:teamId/runs/:runId/resume", (req, res) =>
    res.json(runtime.resume(param(req.params.teamId), param(req.params.runId))),
  );
  router.get("/teams/:teamId/artifact-versions/:artifactId", (req, res) =>
    res.json(
      store.get<ArtifactVersion>(
        "artifacts",
        param(req.params.teamId),
        param(req.params.artifactId),
      ),
    ),
  );
  router.get("/teams/:teamId/events", (req, res) => {
    const teamId = param(req.params.teamId),
      after = cursor(req.query.after);
    const limit = parse(
      z.coerce.number().int().min(1).max(500),
      req.query.limit ?? 200,
    );
    const events = store.events(teamId, after, limit);
    res.json({ events, nextCursor: events.at(-1)?.sequence ?? after });
  });
  router.get("/teams/:teamId/events/stream", (req, res) => {
    const teamId = param(req.params.teamId);
    let after = cursor(req.headers["last-event-id"] ?? req.query.after);
    store.events(teamId, after, 1);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    let writable = true, closed = false, scheduled = false;
    const schedule = () => {
      if (closed || scheduled) return;
      scheduled = true;
      setImmediate(() => { scheduled = false; if (!closed) send(); });
    };
    const send = () => {
      if (runtime.isClosing) {
        res.end();
        return;
      }
      if (!writable) return;
      const events = store.events(teamId, after, 100);
      for (const event of events) {
        writable = res.write(
          `id: ${event.sequence}\nevent: team\ndata: ${JSON.stringify(event)}\n\n`,
        );
        after = event.sequence;
        if (!writable) break;
      }
      if (writable && events.length === 100) schedule();
    };
    const unsubscribe = store.changes.subscribe(schedule);
    const tick = setInterval(send, 5000),
      heartbeat = setInterval(() => {
        if (writable) writable = res.write(": keepalive\n\n");
      }, 15000);
    tick.unref();
    heartbeat.unref();
    res.on("drain", () => {
      writable = true;
      send();
    });
    res.on("close", () => {
      closed = true;
      unsubscribe();
      clearInterval(tick);
      clearInterval(heartbeat);
    });
    send();
  });
  return router;
}
