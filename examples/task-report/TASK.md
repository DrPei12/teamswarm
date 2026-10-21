# Task report

Create a Node.js CLI named `report.mjs`, using only the Node standard library.

- Input: `node report.mjs <json-file>`.
- The input is an array. Each record has a unique, nonempty string `id`, a nonempty string `title`, and `status` equal to `open`, `done`, or `blocked`.
- Reject invalid JSON, non-array input, invalid records and duplicate IDs. Validate every record.
- Success: print exactly one JSON value to stdout, shaped as `{"total":6,"byStatus":{"open":3,"done":2,"blocked":1}}` for the supplied data. Include all three status counts, including zero.
- Failure: exit nonzero, write a useful error to stderr, and leave stdout empty.
- Missing/extra arguments are errors. Do not modify the input file.
- An empty array succeeds with total zero and three zero counts.

Create `summary.md` with the usage, supplied-data result and verification command. Run `node verify.mjs`. Keep the verification scripts and input data unchanged. Deliver `report.mjs` and `summary.md`.
