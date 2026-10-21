# TeamSwarm offline audit CLI

The CLI validates TeamSwarm event envelopes and reports concurrency, work
lifecycle, exchanges and definition changes. Every envelope field is validated
before team selection.

Node.js **24**, ES modules and built-in modules only. No installation, network,
frontend, or credentials are required.

## Usage

```sh
node audit.mjs events.json
node audit.mjs events.json --format json
node audit.mjs events.json --format markdown --team team-id
node audit.mjs --team team-id "events with spaces.json"
node audit.mjs -- -events.json
```

JSON is the default. Exactly one input file is required. Unknown options,
duplicate options, missing values, unsupported formats and extra paths are
errors. Use `--` before a filename beginning with `-`. Successful output goes
to stdout; errors go to stderr with exit status 1 and no partial report.

## Input and selection

Input is a JSON array of envelopes
`{sequence,id,teamId,runId,workId,attemptId,type,data,createdAt}`. The parser
validates the entire file, deduplicates identical event IDs/content, and sorts
by sequence **before** team filtering. Conflicting IDs anywhere in the file
fail, even if their team would be excluded. Empty/whitespace files, invalid
JSON, invalid envelopes and unreadable paths also fail. An empty array is valid.

All nine envelope fields are required. `sequence` is a positive integer;
`id`, `teamId` and `type` are strings; `runId`, `workId` and `attemptId` are
strings or explicit `null`; `data` is a non-null JSON object, not an array.
`createdAt` is a valid ISO calendar timestamp with seconds and an explicit
timezone (`YYYY-MM-DDTHH:mm:ss[.fraction]Z` or `+/-HH:mm`). Impossible dates,
timezone-free values, hour 24 and leap-second notation are rejected.
Additional fields are preserved and participate in duplicate-content comparison.

With `--team`, every metric and the unique unknown-type list uses only events
whose `teamId` exactly matches. Without it all teams are analyzed. Unknown types
remain part of `eventCount` but otherwise do not affect metrics; they are listed
in `unknownEventTypes`. Whole-file parser warnings are not merged into that list.

No matching team produces the following valid zero report, not an error:

```json
{
  "teamId": "absent-team",
  "eventCount": 0,
  "peakConcurrency": 0,
  "workTerminalStates": [],
  "exchangeCounts": {"requests": 0, "reads": 0, "resolved": 0, "cancelled": 0},
  "pauseResumeTransitions": 0,
  "definitionChanges": 0,
  "unknownEventTypes": []
}
```

## Report semantics

- `teamId`: selected string, or `null` for all teams.
- `eventCount`: unique selected events, including unknown types.
- `peakConcurrency`: maximum simultaneous occupied works. `work.running`
  starts occupation; repeated running does not inflate it. Submitted, accepted,
  failed, interrupted and yielded end occupation. Waiting, stopping and recovery
  states do not prove occupation ended.
- `workTerminalStates`: an array of `{teamId,runId,workId,state}` records, not
  event totals. `state` is `submitted|accepted|failed|interrupted|yielded`.
  Each record identifies a work whose **latest observed lifecycle** is terminal.
  A subsequent running or other nonterminal lifecycle removes its stale terminal
  record. Team/run/work identity avoids collisions across teams and runs.
- `exchangeCounts.requests`: `exchange.message` with `data.kind === 'request'`.
- `exchangeCounts.reads`: number of `exchange.read` events, not the number of
  message IDs. Header delivery is not body reading, understanding or application.
- `exchangeCounts.resolved` and `.cancelled`: `exchange.closed` events with
  exactly the matching outcome. **Resolved is a member claim, not independently
  verified success, work acceptance, or proof that a problem was solved.**
- `pauseResumeTransitions`: same-team/run `run.paused` then `run.resumed` pairs;
  each pause state is consumed once. Work yielding/waiting is not a user pause.
- `definitionChanges`: only `project.node_created` with
  `data.kind === 'definition'`. Missing kind, `nodeKind` alone, checkpoints,
  work-result and artifact nodes do not count.

The synthetic sample contains 54 events, peak concurrency 4, four submitted
terminal records, three requests, eight read events, three resolved exchanges,
zero cancelled exchanges, zero pause pairs and zero definition changes.

## Verification

```sh
node --test
node --test tests/cli-e2e.test.mjs tests/integration-regressions.test.mjs
node --check audit.mjs
```

Tests cover missing envelope fields, invalid types and timestamps, filtering,
duplicate events, lifecycle transitions and the CLI output/exit protocol.
CLI contract tests execute the parser and analyzers in subprocesses.
