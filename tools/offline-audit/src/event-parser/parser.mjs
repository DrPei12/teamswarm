import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

const KNOWN_EVENT_TYPES = new Set([
  'run.paused',
  'run.resumed',
  'work.running',
  'work.submitted',
  'work.accepted',
  'work.failed',
  'work.interrupted',
  'work.yielded',
  'work.waiting',
  'work.stopping',
  'recovery_required',
  'exchange.message',
  'exchange.headers_delivered',
  'exchange.read',
  'exchange.closed',
  'project.node_created',
]);

const REQUIRED_FIELDS = ['sequence', 'id', 'type', 'teamId', 'runId', 'workId', 'attemptId', 'data', 'createdAt'];

// An ISO calendar timestamp with seconds and an explicit UTC/offset zone.
// Date.parse alone normalizes impossible dates such as February 30.
function isTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1]
    && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59
    && (offsetHour === undefined || (Number(offsetHour) <= 23 && Number(offsetMinute) <= 59))
    && Number.isFinite(Date.parse(value));
}

/**
 * Parse an event JSON file, validate its schema, deduplicate by id,
 * sort by sequence ascending, and collect warnings for unknown types.
 *
 * @param {string} filePath - Path to the JSON events file.
 * @returns {Promise<{events: Array<object>, warnings: string[]}>}
 */
export async function parseEvents(filePath) {
  // 1. Read file
  const raw = await readFile(filePath, 'utf-8');

  // 2. Empty or whitespace-only check
  if (raw.trim().length === 0) {
    throw new Error('Empty file');
  }

  // 3. Parse JSON
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err.message}`);
  }

  // 4. Must be an array
  if (!Array.isArray(parsed)) {
    throw new Error('Expected JSON array');
  }

  // 5. Validate each element's required fields
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`Event at index ${i} is not an object`);
    }
    for (const field of REQUIRED_FIELDS) {
      if (!(field in item)) {
        throw new Error(`Event at index ${i} is missing required field: ${field}`);
      }
    }
    if (!Number.isInteger(item.sequence) || item.sequence <= 0) {
      throw new Error(`Event at index ${i} has invalid sequence: must be a positive integer`);
    }
    if (typeof item.id !== 'string') {
      throw new Error(`Event at index ${i} has invalid id: must be a string`);
    }
    if (typeof item.type !== 'string') {
      throw new Error(`Event at index ${i} has invalid type: must be a string`);
    }
    if (typeof item.teamId !== 'string') {
      throw new Error(`Event at index ${i} has invalid teamId: must be a string`);
    }
    for (const field of ['runId', 'workId', 'attemptId']) {
      if (item[field] !== null && typeof item[field] !== 'string') {
        throw new Error(`Event at index ${i} has invalid ${field}: must be a string or null`);
      }
    }
    if (item.data === null || typeof item.data !== 'object' || Array.isArray(item.data)) {
      throw new Error(`Event at index ${i} has invalid data: must be an object`);
    }
    if (!isTimestamp(item.createdAt)) {
      throw new Error(`Event at index ${i} has invalid createdAt: must be an ISO timestamp with a timezone`);
    }
  }

  // 7. Deduplicate by id
  const byId = new Map();
  for (const item of parsed) {
    const key = item.id;
    if (byId.has(key)) {
      const existing = byId.get(key);
      if (!isDeepStrictEqual(existing, item)) {
        throw new Error(`Conflicting duplicate event id: ${key}`);
      }
      // Identical content — keep one silently
    } else {
      byId.set(key, item);
    }
  }

  const unique = [...byId.values()];

  // 6. Sort by sequence ascending
  unique.sort((a, b) => a.sequence - b.sequence);

  // 8. Collect unknown event types into warnings
  const warnings = [];
  for (const ev of unique) {
    if (!KNOWN_EVENT_TYPES.has(ev.type)) {
      const msg = `Unknown event type: ${ev.type}`;
      if (!warnings.includes(msg)) {
        warnings.push(msg);
      }
    }
  }

  // 9. Return result
  return { events: unique, warnings };
}
