# Follow-up: filter by status

Extend `report.mjs` to accept `node report.mjs <json-file> --status open|done|blocked`.

Keep the original unfiltered invocation and output contract. With a filter, count only matching records and include zero counts for other statuses. Validate the entire input before filtering, including records that do not match the filter. Unknown, missing or duplicate flags are errors with empty stdout and a nonzero exit.

Update `summary.md` with filtered usage. Run `node verify.mjs` and `node verify-followup.mjs`, then deliver updated versions of the two files. Keep the supplied data and checks unchanged.
