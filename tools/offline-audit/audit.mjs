#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

export const USAGE = 'Usage: node audit.mjs <events.json> [--format json|markdown] [--team <teamId>]';

export function parseArgs(args) {
  let filePath;
  let format = 'json';
  let teamId = null;
  const seen = new Set();
  let positionalOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!positionalOnly && arg === '--') { positionalOnly = true; continue; }
    if (!positionalOnly && (arg === '--format' || arg === '--team')) {
      if (seen.has(arg)) throw new Error(`Duplicate option: ${arg}`);
      seen.add(arg);
      const value = args[++i];
      if (!value || !value.trim() || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--format') {
        if (!['json', 'markdown'].includes(value)) throw new Error(`Invalid format: ${value}; expected json or markdown`);
        format = value;
      } else teamId = value;
    } else {
      if (!positionalOnly && arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
      if (!arg.trim()) throw new Error('Input file path must not be empty');
      if (filePath !== undefined) throw new Error(`Unexpected argument: ${arg}`);
      filePath = arg;
    }
  }
  if (filePath === undefined) throw new Error('Missing input file');
  return { filePath, format, teamId };
}

async function loadModules() {
  const [parser, concurrency, exchanges, formatter] = await Promise.all([
    import('./src/event-parser/parser.mjs'),
    import('./src/concurrency-analyzer/analyzer.mjs'),
    import('./src/exchange-analyzer/analyzer.mjs'),
    import('./src/formatter/formatter.mjs'),
  ]);
  return { ...parser, ...concurrency, ...exchanges, ...formatter };
}

// Dependency injection is solely a unit-test seam. Normal CLI execution always
// loads the real modules above; there is no fallback report or mock mode.
export async function runAudit(options, modules) {
  const { parseEvents, analyzeConcurrency, analyzeExchanges, formatReport } = modules ?? await loadModules();
  const { events } = await parseEvents(options.filePath);
  // Parser validates ALL input and deduplicates/sorts before this selection.
  // Its whole-file warnings must not leak unselected unknown event types.
  const selected = options.teamId === null ? events : events.filter(event => event.teamId === options.teamId);
  const { peakConcurrency, workTerminalStates, pauseResumeTransitions } = analyzeConcurrency(selected);
  const { requests, reads, resolved, cancelled, definitionChanges, unknownEventTypes } = analyzeExchanges(selected);
  return formatReport({
    teamId: options.teamId,
    eventCount: selected.length,
    peakConcurrency,
    workTerminalStates,
    exchangeCounts: { requests, reads, resolved, cancelled },
    pauseResumeTransitions,
    definitionChanges,
    unknownEventTypes,
  }, options.format);
}

export async function main(args = process.argv.slice(2), io = process, modules) {
  try {
    const options = parseArgs(args);
    const output = await runAudit(options, modules);
    io.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`audit: ${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
