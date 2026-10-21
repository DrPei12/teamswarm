/** Pure analysis of parser-sorted, deduplicated, optionally filtered events. */
export function analyzeConcurrency(events) {
  const running = new Set(), terminal = new Map(), paused = new Set();
  const endings = new Set(['submitted','accepted','failed','interrupted','yielded']);
  const lifecycle = new Set(['running','waiting','stopping','recovery_required']);
  let peakConcurrency = 0, pauseResumeTransitions = 0;
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event.type !== 'string') continue;
    const teamId = event.teamId ?? null, runId = event.runId ?? null;
    if (runId !== null && (event.type === 'run.paused' || event.type === 'run.resumed')) {
      const key = JSON.stringify([teamId,runId]);
      if (event.type === 'run.paused') paused.add(key);
      else if (paused.delete(key)) pauseResumeTransitions++;
    }
    if ((!event.type.startsWith('work.') && event.type !== 'recovery_required') || event.workId == null) continue;
    const state = event.type === 'recovery_required' ? event.type : event.type.slice(5);
    const key = JSON.stringify([teamId,runId,event.workId]);
    if (endings.has(state)) {
      running.delete(key);
      terminal.set(key,{teamId,runId,workId:event.workId,state});
    } else if (lifecycle.has(state)) {
      terminal.delete(key);
      // Nonterminal observations do not prove occupation ended.
      if (state === 'running') {
        running.add(key);
        peakConcurrency = Math.max(peakConcurrency,running.size);
      }
    }
  }
  return {peakConcurrency,workTerminalStates:[...terminal.values()],pauseResumeTransitions};
}
