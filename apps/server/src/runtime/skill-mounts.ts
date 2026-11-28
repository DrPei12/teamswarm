import type { Skill } from "@team/contracts/product";
import { conflict } from "../errors.js";
import { hash, type RuntimeStore } from "./store.js";
import { GlobalSkills } from "./global-skills.js";
import type { Run, SkillMount, MessageSkillMount, GlobalSkillPin, Work } from "./types.js";

type Instruction = { name: string; instructions: string };
type Compiled = Instruction & Omit<MessageSkillMount, "sourceMessageId">;

export class SkillMounts {
  readonly global: GlobalSkills;
  constructor(private store: RuntimeStore) {
    this.global = new GlobalSkills(store);
    store.db.exec(`CREATE TABLE IF NOT EXISTS runtime_skill_grants (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      skill_id TEXT NOT NULL, generation INTEGER NOT NULL, active INTEGER NOT NULL,
      PRIMARY KEY(team_id,skill_id));`);
    store.changes.track("runtime_skill_grants", "skill_grants", "team_id", true);
  }

  sync(before: Skill[], after: Skill[]) {
    const key = (skill: Skill) => JSON.stringify([skill.teamId, skill.id]);
    const previous = new Set(before.map(key));
    const next = new Set(after.map(key));
    const revoke = this.store.db.prepare(`
      INSERT INTO runtime_skill_grants VALUES(?,?,2,0)
      ON CONFLICT(team_id,skill_id) DO UPDATE SET generation=generation+1,active=0
      WHERE active=1
    `);
    const activate = this.store.db.prepare(`
      INSERT INTO runtime_skill_grants VALUES(?,?,1,1)
      ON CONFLICT(team_id,skill_id) DO UPDATE SET active=1 WHERE active=0
    `);
    for (const skill of before)
      if (!next.has(key(skill)) && this.store.teams.getTeam(skill.teamId)) revoke.run(skill.teamId, skill.id);
    for (const skill of after)
      if (!previous.has(key(skill)) && this.store.teams.getTeam(skill.teamId)) activate.run(skill.teamId, skill.id);
    if (before.some(skill => !next.has(key(skill))) || after.some(skill => !previous.has(key(skill))))
      this.store.changes.signal();
  }

  compile(skill: Skill): Compiled {
    this.store.db.prepare("INSERT OR IGNORE INTO runtime_skill_grants VALUES(?,?,1,1)").run(skill.teamId, skill.id);
    const grant = this.grant(skill.teamId, skill.id);
    if (!grant?.active) throw conflict("skill_revoked", "Select a currently available skill.");
    return {
      skillId: skill.id, name: skill.name, instructions: skill.instructions,
      revision: hash(JSON.stringify([skill.name, skill.instructions])),
      generation: Number(grant.generation),
    };
  }

  private grant(teamId: string, skillId: string) {
    return this.store.db.prepare("SELECT active,generation FROM runtime_skill_grants WHERE team_id=? AND skill_id=?").get(teamId, skillId);
  }

  private source(teamId: string, messageId: string): Compiled[] {
    if (!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='product_message_details'").get()) return [];
    const row = this.store.db.prepare(`
      SELECT d.data FROM product_message_details d JOIN messages m ON m.id=d.message_id
      JOIN conversations c ON c.id=m.conversation_id
      WHERE c.team_id=? AND m.id=? AND m.role='user'
    `).get(teamId, messageId);
    const entries = row ? JSON.parse(String(row.data)).executionInput?.instructions : undefined;
    return Array.isArray(entries) ? entries.filter(entry =>
      typeof entry?.skillId === "string" && typeof entry.revision === "string" &&
      Number.isSafeInteger(entry.generation) && typeof entry.instructions === "string") : [];
  }

  pin(run: Run, requested: (Pick<MessageSkillMount, "skillId" | "revision" | "source"> | GlobalSkillPin)[], scope: GlobalSkillPin[] = []): SkillMount[] {
    const granted = requested.some(item => item.source !== "global") ? this.source(run.teamId, run.sourceMessageId) : [];
    return requested.map(item => {
      if (item.source === "global") return this.global.verify(run.teamId, item, scope);
      const { skillId, revision } = item;
      const snapshot = granted.find(item => item.skillId === skillId && item.revision === revision);
      if (!snapshot) throw conflict("skill_grant_required", "Use a skill version selected in this user message.");
      const mount = { skillId, revision, generation: snapshot.generation, sourceMessageId: run.sourceMessageId };
      if (!this.active(run.teamId, mount)) throw conflict("skill_revoked", "The skill authorization ended.");
      return mount;
    });
  }

  active(teamId: string, mount: Pick<MessageSkillMount, "skillId" | "generation" | "source"> | GlobalSkillPin) {
    if (mount.source === "global") return this.global.active(teamId, mount);
    const current = this.grant(teamId, mount.skillId);
    return !!current?.active && Number(current.generation) === mount.generation;
  }

  allowed(work: Work) {
    return (work.skillMounts ?? []).every(mount => this.active(work.teamId, mount));
  }

  instructions(work: Work) {
    const sources = new Map<string, Compiled[]>();
    return (work.skillMounts ?? []).map(mount => {
      if (mount.source === "global") return this.global.body(work.teamId, mount);
      if (!this.active(work.teamId, mount)) throw conflict("skill_revoked", "The mounted skill authorization ended.");
      if (!sources.has(mount.sourceMessageId)) sources.set(mount.sourceMessageId, this.source(work.teamId, mount.sourceMessageId));
      const found = sources.get(mount.sourceMessageId)!.find(item =>
        item.skillId === mount.skillId && item.revision === mount.revision && item.generation === mount.generation);
      if (!found) throw conflict("skill_snapshot_missing", "The mounted skill snapshot is unavailable.");
      return { ...mount, name: found.name, instructions: found.instructions };
    });
  }
}
