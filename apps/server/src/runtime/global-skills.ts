import { randomUUID } from "node:crypto";
import type { GlobalSkillCatalog, GlobalSkillPin, GlobalSkillSummary } from "@team/contracts/runtime";
import { conflict, notFound } from "../errors.js";
import { hash, type RuntimeStore } from "./store.js";

type Edit = { name: string; instructions: string };
type Change = ({ action: "create" } & Edit) | ({ action: "edit"; skillId: string } & Edit) |
  { action: "archive" | "restore"; skillId: string };
type Grant = { skillId: string; revision: number; active: boolean; expectedGeneration: number; expectedVersion: number };
const pin = (skillId: string, revision: number, generation: number): GlobalSkillPin => ({ source: "global", skillId, revision, generation });
const same = (a: GlobalSkillPin, b: GlobalSkillPin) => a.skillId === b.skillId && a.revision === b.revision && a.generation === b.generation;

export class GlobalSkills {
  constructor(private readonly store: RuntimeStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS global_skill_catalog (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
      INSERT OR IGNORE INTO global_skill_catalog VALUES(1,0);
      CREATE TABLE IF NOT EXISTS global_skills (id TEXT PRIMARY KEY, head INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS global_skill_revisions (skill_id TEXT NOT NULL REFERENCES global_skills(id), revision INTEGER NOT NULL,
        name TEXT NOT NULL, instructions TEXT NOT NULL, PRIMARY KEY(skill_id,revision));
      CREATE TRIGGER IF NOT EXISTS global_skill_revision_no_update BEFORE UPDATE ON global_skill_revisions
        BEGIN SELECT RAISE(ABORT,'Skill revisions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS global_skill_revision_no_delete BEFORE DELETE ON global_skill_revisions
        BEGIN SELECT RAISE(ABORT,'Skill revisions are immutable'); END;
      CREATE TABLE IF NOT EXISTS global_skill_grants (team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, skill_id TEXT NOT NULL,
        revision INTEGER NOT NULL, generation INTEGER NOT NULL, active INTEGER NOT NULL, PRIMARY KEY(team_id,skill_id),
        FOREIGN KEY(skill_id,revision) REFERENCES global_skill_revisions(skill_id,revision));`);
    store.changes.track("global_skill_grants", "global_skill_grants", "team_id", true);
  }

  private version() {
    return Number(this.store.db.prepare("SELECT version FROM global_skill_catalog WHERE id=1").get()!.version);
  }
  private checkVersion(expected: number) {
    if (this.version() !== expected) throw conflict("skill_catalog_changed", "The skill catalog changed. Reload before saving.");
  }
  private checkTeam(teamId: string) {
    if (!this.store.teams.getTeam(teamId)) throw notFound();
  }

  // Administrative catalog: only names, version heads and this team's own grants. Bodies are fetched individually.
  catalog(teamId?: string): GlobalSkillCatalog {
    if (teamId !== undefined) this.checkTeam(teamId);
    const rows = this.store.db.prepare(`SELECT s.id,s.head,s.archived,r.name,g.revision,g.generation,g.active FROM global_skills s
      JOIN global_skill_revisions r ON r.skill_id=s.id AND r.revision=s.head
      LEFT JOIN global_skill_grants g ON g.skill_id=s.id AND g.team_id=? WHERE (? IS NULL OR s.archived=0) ORDER BY r.name,s.id`)
      .all(teamId ?? null, teamId ?? null);
    return { version: this.version(), skills: rows.map(row => ({ skillId: String(row.id), revision: Number(row.head),
      name: String(row.name), archived: Boolean(row.archived), ...(row.generation === null ? {} : { grant: {
        revision: Number(row.revision), generation: Number(row.generation), active: Boolean(row.active),
      } }) })) };
  }

  revision(skillId: string, revision: number): Edit {
    const row = this.store.db.prepare("SELECT name,instructions FROM global_skill_revisions WHERE skill_id=? AND revision=?").get(skillId, revision);
    if (!row) throw notFound();
    return { name: String(row.name), instructions: String(row.instructions) };
  }

  change(expectedVersion: number, input: Change) {
    return this.store.transaction(() => {
      this.checkVersion(expectedVersion);
      const db = this.store.db;
      const id = input.action === "create" ? randomUUID() : input.skillId;
      const current = db.prepare("SELECT head,archived FROM global_skills WHERE id=?").get(id);
      if (input.action !== "create" && !current) throw notFound();
      if (input.action === "create" || input.action === "edit") {
        if (current?.archived) throw conflict("skill_archived", "Restore this skill before editing it.");
        const head = Number(current?.head ?? 0) + 1;
        if (!current) db.prepare("INSERT INTO global_skills(id,head) VALUES(?,?)").run(id, head);
        else db.prepare("UPDATE global_skills SET head=? WHERE id=?").run(head, id);
        db.prepare("INSERT INTO global_skill_revisions VALUES(?,?,?,?)").run(id, head, input.name, input.instructions);
      } else {
        const archive = input.action === "archive";
        if (Boolean(current!.archived) === archive) throw conflict("skill_state", "Reload the current skill state.");
        db.prepare("UPDATE global_skills SET archived=? WHERE id=?").run(Number(archive), id);
        if (archive) db.prepare("UPDATE global_skill_grants SET active=0,generation=generation+1 WHERE skill_id=? AND active=1").run(id);
      }
      db.prepare("UPDATE global_skill_catalog SET version=version+1 WHERE id=1").run();
      this.store.afterCommit(() => this.store.changes.signal());
      return { skillId: id, version: expectedVersion + 1 };
    });
  }

  changeGrant(teamId: string, input: Grant) {
    return this.store.transaction(() => {
      this.checkTeam(teamId);
      this.checkVersion(input.expectedVersion);
      const db = this.store.db;
      const available = db.prepare(`SELECT 1 FROM global_skill_revisions r JOIN global_skills s ON s.id=r.skill_id
        WHERE s.archived=0 AND r.skill_id=? AND r.revision=?`).get(input.skillId, input.revision);
      if (!available) throw conflict("skill_revision_unavailable", "Select an available skill revision.");
      const current = db.prepare("SELECT * FROM global_skill_grants WHERE team_id=? AND skill_id=?").get(teamId, input.skillId);
      if (Number(current?.generation ?? 0) !== input.expectedGeneration) throw conflict("skill_grant_changed", "Reload the current skill authorization.");
      if (!input.active && (!current || Number(current.revision) !== input.revision)) throw conflict("skill_grant_changed", "Revoke the authorized revision.");
      const unchanged = current && Boolean(current.active) === input.active && Number(current.revision) === input.revision;
      const generation = input.expectedGeneration + (unchanged ? 0 : 1);
      if (!unchanged) {
        db.prepare(`INSERT INTO global_skill_grants VALUES(?,?,?,?,?) ON CONFLICT(team_id,skill_id) DO UPDATE SET
          revision=excluded.revision,generation=excluded.generation,active=excluded.active`)
          .run(teamId, input.skillId, input.revision, generation, Number(input.active));
        this.store.event(teamId, input.active ? "skill.granted" : "skill.revoked", { ...pin(input.skillId, input.revision, generation) });
      }
      return { revision: input.revision, active: input.active, generation };
    });
  }

  visible(teamId: string): GlobalSkillSummary[] {
    return this.store.db.prepare(`SELECT g.skill_id,g.revision,g.generation,r.name FROM global_skill_grants g
      JOIN global_skills s ON s.id=g.skill_id JOIN global_skill_revisions r ON r.skill_id=g.skill_id AND r.revision=g.revision
      WHERE g.team_id=? AND g.active=1 AND s.archived=0 ORDER BY g.skill_id`).all(teamId)
      .map(row => ({ mount: pin(String(row.skill_id), Number(row.revision), Number(row.generation)), name: String(row.name) }));
  }
  active(teamId: string, mount: GlobalSkillPin) {
    return !!this.store.db.prepare(`SELECT 1 FROM global_skill_grants g JOIN global_skills s ON s.id=g.skill_id WHERE s.archived=0
      AND g.active=1 AND g.team_id=? AND g.skill_id=? AND g.revision=? AND g.generation=?`).get(teamId, mount.skillId, mount.revision, mount.generation);
  }
  verify(teamId: string, mount: GlobalSkillPin, scope?: GlobalSkillPin[]) {
    if (scope && !scope.some(entry => same(entry, mount))) throw conflict("skill_scope", "Select a skill authorized for this Host turn.");
    if (!this.active(teamId, mount)) throw conflict("skill_grant_changed", "The selected skill authorization changed. Select its current revision.");
    return mount;
  }
  body(teamId: string, mount: GlobalSkillPin) {
    this.verify(teamId, mount);
    return { ...mount, ...this.revision(mount.skillId, mount.revision) };
  }
  page(teamId: string, attemptId: string, scope: GlobalSkillPin[], input: { limit: number; cursor?: string }) {
    const captured = new Map(scope.map(entry => [entry.skillId, entry]));
    const items = this.visible(teamId).filter(({ mount }) => {
      const entry = captured.get(mount.skillId);
      return entry !== undefined && same(entry, mount);
    });
    const version = hash(JSON.stringify([teamId, attemptId, items.map(item => item.mount)]));
    const offset = this.offset(input.cursor, version, items.length);
    const next = offset + input.limit;
    return { items: items.slice(offset, next), nextCursor: next < items.length ? `${version}:${next}` : null };
  }
  read(teamId: string, attemptId: string, scope: GlobalSkillPin[], input: { mount: GlobalSkillPin; limit: number; cursor?: string }) {
    const mount = this.verify(teamId, input.mount, scope);
    const { name, instructions } = this.revision(mount.skillId, mount.revision);
    const version = hash(JSON.stringify([teamId, attemptId, mount.skillId, mount.revision, mount.generation]));
    const offset = this.offset(input.cursor, version, instructions.length);
    let end = Math.min(offset + input.limit, instructions.length);
    // Keep surrogate pairs together at UTF-16 page boundaries.
    if (end < instructions.length && /[\uD800-\uDBFF]/.test(instructions[end - 1]) && /[\uDC00-\uDFFF]/.test(instructions[end])) end++;
    return { mount, name, instructions: instructions.slice(offset, end), offset, total: instructions.length,
      nextCursor: end < instructions.length ? `${version}:${end}` : null };
  }
  private offset(cursor: string | undefined, version: string, length: number) {
    if (cursor === undefined) return 0;
    const [binding, n] = cursor.split(":");
    const offset = Number(n);
    if (binding !== version || !Number.isSafeInteger(offset) || offset < 0 || offset >= length)
      throw conflict("skill_cursor_changed", "Start a new skill query in the current Host turn.");
    return offset;
  }
}
