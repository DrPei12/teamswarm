import type { ToolSpec } from "../types.js";

export const piChildReadChars = 12000;
export const piChildRequestBytes = 256 * 1024;
export const piChildOutputTokens = 4096;
export const piChildLifetimeMs = 240000;
export const piChildMaxPaths = 32;
export const piChildMaxRequests = 32;

const prompt = { type: "string", minLength: 1, maxLength: 8000 };
const string = (maxLength: number, minLength = 0) => ({ type: "string", minLength, maxLength });
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object", properties, required, additionalProperties: false,
});

export const piDelegateTool: ToolSpec = {
  name: "team_pi_delegate",
  description: "Run an independent Pi child in its own snapshot. Assign a task and exact project file paths owned by this Work. Returns the child's summary and submitted file hashes; use team_subspace_commit to apply the proposed change to your copy.",
  inputSchema: object({ task: prompt, paths: {
    type: "array", minItems: 1, maxItems: piChildMaxPaths, items: string(1000, 1),
  } }, ["task", "paths"]),
};

export const piChildToolNames = ["team_read_file", "team_write_file", "team_edit_file", "team_subspace_submit"] as const;

export function piChildTools(paths: readonly string[]): ToolSpec[] {
  const path = { type: "string", enum: [...paths] };
  return [
    { name: piChildToolNames[0], description: "Read an assigned file and its SHA-256. Advance offset by the length of the returned text when truncated.",
      inputSchema: object({ path, offset: { type: "integer", minimum: 0, maximum: 2 * 1024 * 1024 },
        limit: { type: "integer", minimum: 1, maximum: piChildReadChars } }, ["path"]) },
    { name: piChildToolNames[1], description: "Create a missing assigned UTF-8 file. Set expectedSha256 to null.",
      inputSchema: object({ path, text: string(2 * 1024 * 1024), expectedSha256: { type: "null" } }, ["path", "text", "expectedSha256"]) },
    { name: piChildToolNames[2], description: "Replace one exact matching fragment in an assigned file. Use the current SHA-256 from team_read_file.",
      inputSchema: object({ path, oldText: string(200000, 1), newText: string(200000),
        expectedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" } }, ["path", "oldText", "newText", "expectedSha256"]) },
    { name: piChildToolNames[3], description: "Freeze your file changes for the parent. Then give a concise summary and finish.", inputSchema: object({}, []) },
  ];
}
