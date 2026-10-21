/**
 * Formatter module for TeamSwarm audit reports.
 * Formats structured audit data as JSON string or Markdown report.
 */

/**
 * Format the audit report data.
 * @param {object} data - Structured audit data object
 * @param {'json'|'markdown'} format - Output format
 * @returns {string} Formatted report string
 */
export function formatReport(data, format) {
  if (format === 'json') {
    return formatJson(data);
  } else if (format === 'markdown') {
    return formatMarkdown(data);
  }
  throw new Error(`Unknown format: ${format}. Expected 'json' or 'markdown'.`);
}

function formatJson(data) {
  // Ensure teamId is first field by constructing an ordered object
  const ordered = {};
  if (data.teamId !== undefined) {
    ordered.teamId = data.teamId;
  }
  for (const [key, value] of Object.entries(data)) {
    if (key !== 'teamId') {
      ordered[key] = value;
    }
  }
  return JSON.stringify(ordered, null, 2);
}

// Encode syntax as entities so identifiers cannot introduce tables, links or HTML.
function escapeMarkdown(value) {
  return String(value).replace(/[&<>|\\`*_\[\]{}()#!~\r\n\u0000-\u001f\u007f]/g,
    char => `&#${char.codePointAt(0)};`);
}

function formatMarkdown(data) {
  const lines = [];

  // Title
  lines.push('# TeamSwarm Audit Report');
  lines.push('');

  // Summary section
  lines.push('## Summary');
  lines.push('');
  lines.push(`- **Team ID:** ${data.teamId == null ? '(all teams)' : escapeMarkdown(data.teamId)}`);
  lines.push(`- **Event Count:** ${data.eventCount ?? 0}`);
  lines.push(`- **Peak Concurrency:** ${data.peakConcurrency ?? 0}`);
  lines.push(`- **Pause/Resume Transitions:** ${data.pauseResumeTransitions ?? 0}`);
  lines.push(`- **Definition Changes:** ${data.definitionChanges ?? 0}`);
  lines.push('');

  // Work terminal states table
  lines.push('## Work Terminal States');
  lines.push('');
  lines.push('| Team ID | Run ID | Work ID | State |');
  lines.push('|---------|--------|---------|-------|');
  const wts = data.workTerminalStates ?? [];
  for (const record of wts) {
    lines.push(`| ${[record.teamId, record.runId, record.workId, record.state].map(escapeMarkdown).join(' | ')} |`);
  }
  if (wts.length === 0) lines.push('', 'No terminal work records.');
  lines.push('');

  // Exchange activity table
  lines.push('## Exchange Activity');
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('|--------|-------|');
  const ec = data.exchangeCounts || {};
  lines.push(`| Requests | ${ec.requests ?? 0} |`);
  lines.push(`| Actual body-read events | ${ec.reads ?? 0} |`);
  lines.push(`| Resolved claims | ${ec.resolved ?? 0} |`);
  lines.push(`| Cancelled closures | ${ec.cancelled ?? 0} |`);
  lines.push('');
  lines.push('Requests count exchange.message events with kind=request. Reads count actual exchange.read body-read events, not delivered headers or individual message IDs.');
  lines.push('Resolved is a member claim, not independent verification of a successful outcome. Cancelled closures are reported separately.');
  lines.push('');

  // Unknown event types section (only if any)
  const unknownTypes = data.unknownEventTypes || [];
  if (unknownTypes.length > 0) {
    lines.push('## Unknown Event Types');
    lines.push('');
    for (const t of unknownTypes) {
      lines.push(`- ${escapeMarkdown(t)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
