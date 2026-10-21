const KNOWN_EVENT_TYPES = new Set([
  'work.running',
  'work.submitted',
  'work.accepted',
  'work.failed',
  'work.interrupted',
  'work.yielded',
  'work.waiting',
  'work.stopping',
  'recovery_required',
  'work.recovery_required',
  'run.paused',
  'run.resumed',
  'exchange.message',
  'exchange.headers_delivered',
  'exchange.read',
  'exchange.closed',
  'project.node_created',
]);

/**
 * Analyze validated, deduplicated events, already filtered by the caller.
 * Headers are known events, never reads. A resolved closure is a member
 * claim, not independent evidence of successful work.
 *
 * @param {Array<{type: string, data?: object}>} events
 * @returns {{requests: number, reads: number, resolved: number, cancelled: number, definitionChanges: number, unknownEventTypes: string[]}}
 */
export function analyzeExchanges(events) {
  let requests = 0;
  let reads = 0;
  let resolved = 0;
  let cancelled = 0;
  let definitionChanges = 0;
  const unknownSet = new Set();

  for (const event of events) {
    const type = event?.type;

    switch (type) {
      case 'exchange.message':
        if (event.data?.kind === 'request') {
          requests += 1;
        }
        break;
      case 'exchange.read':
        reads += 1;
        break;
      case 'exchange.closed':
        if (event.data?.outcome === 'resolved') resolved += 1;
        if (event.data?.outcome === 'cancelled') cancelled += 1;
        break;
      case 'project.node_created':
        if (event.data?.kind === 'definition') definitionChanges += 1;
        break;
      default:
        if (!KNOWN_EVENT_TYPES.has(type)) {
          unknownSet.add(type);
        }
        break;
    }
  }

  return {
    requests,
    reads,
    resolved,
    cancelled,
    definitionChanges,
    unknownEventTypes: [...unknownSet].sort(),
  };
}
