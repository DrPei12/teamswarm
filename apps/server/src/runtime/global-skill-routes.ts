import { Router } from "express";
import { z } from "zod";
import type { GlobalSkills } from "./global-skills.js";
import { globalSkillPin, key, parse } from "./validation.js";

const expectedVersion = z.number().int().nonnegative();
const skillId = globalSkillPin.shape.skillId;
const revision = globalSkillPin.shape.revision;
const text = { name: z.string().trim().min(1).max(80), instructions: z.string().min(1).max(40000).refine(value => !!value.trim(), "Enter skill instructions.") };
const change = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), expectedVersion, ...text }).strict(),
  z.object({ action: z.literal("edit"), expectedVersion, skillId, ...text }).strict(),
  z.object({ action: z.enum(["archive", "restore"]), expectedVersion, skillId }).strict(),
]);
const grant = z.object({ skillId, revision, expectedVersion, active: z.boolean(), expectedGeneration: z.number().int().nonnegative() }).strict();

export function globalSkillRoutes(skills: GlobalSkills) {
  const router = Router();
  router.get("/global/text-skills", (_req, res) => res.json(skills.catalog()));
  router.post("/global/text-skills", (req, res) => {
    const input = parse(change, req.body);
    res.json(skills.change(input.expectedVersion, input));
  });
  router.get("/global/text-skills/:id/revisions/:revision", (req, res) => {
    res.json(skills.revision(parse(skillId, req.params.id), parse(revision, Number(req.params.revision))));
  });
  router.get("/teams/:teamId/text-skill-catalog", (req, res) => res.json(skills.catalog(parse(key, req.params.teamId))));
  router.put("/teams/:teamId/text-skill-grants", (req, res) => res.json(skills.changeGrant(parse(key, req.params.teamId), parse(grant, req.body))));
  router.get("/teams/:teamId/authorized-text-skills", (req, res) => res.json(skills.visible(parse(key, req.params.teamId))));
  return router;
}
