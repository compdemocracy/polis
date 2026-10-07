// A TypeScript port of the math poller's closed-shape line validators, so the
// ops pages relay only fields the poller's own schema allows:
//
//   math_poller readiness/1 role=<role> progress=<progress> {json}
//     delphi/polismath/poller/readiness.py: LINE_KEYS, DISCOVERY_KEYS,
//     QUEUE_KEYS, SWEEP_KEYS, DRAIN_KEYS, ADMISSION_KEYS, validate_line,
//     parse_readiness (_LINE).
//   math_poller discovery_stale/1 {json}
//     readiness.py: STALE_KEYS, parse_stale.
//   {"schema":"math_poller.capacity/1", ...}
//     delphi/polismath/poller/capacity.py: LINE_KEYS, LARGE_LINE_KEYS,
//     CAPACITY_REV_KEYS, decode_counts, validate_large_counts, parse_line.
//
// A line that does not match its closed shape throws, and the caller counts
// it as malformed; it is never relayed. Every value that leaves is a count, a
// millisecond clock, a closed label or a hex digest.

export const LINE_KEYS = [
  "schema",
  "seq",
  "emitted_ms",
  "role",
  "progress",
  "instance_sha256",
  "instance_source",
  "image_digest",
  "source_commit",
  "run",
  "config",
  "poller_config",
  "interval_s",
  "stale_s",
  "discovery",
  "queue",
  "sweep",
  "drain",
  "admission",
] as const;
export const OPTIONAL_LINE_KEYS = ["capacity"] as const;
export const DISCOVERY_KEYS = [
  "successes",
  "consecutive",
  "last_success_ms",
  "last_success_age_ms",
  "failures_since_success",
  "last_error",
  "last_error_ms",
] as const;
export const QUEUE_KEYS = [
  "pending",
  "in_flight",
  "parked",
  "oldest_live_age_ms",
  "oldest_backfill_age_ms",
  "oldest_work_age_ms",
] as const;
export const SWEEP_KEYS = [
  "sweep_no",
  "finished_ms",
  "run",
  "config",
  "status",
  "unresolved",
  "parked_live",
  "in_flight",
] as const;
export const DRAIN_KEYS = ["run", "drained_ms"] as const;
export const ADMISSION_KEYS = [
  "budget_mb",
  "reserved_mb",
  "granted",
  "held",
  "waiting",
] as const;
export const STALE_KEYS = [
  "schema",
  "seq",
  "emitted_ms",
  "run",
  "reason",
  "age_ms",
  "stale_s",
] as const;

export const COUNT_KEYS = [
  "routing",
  "large_demand",
  "large_leased",
  "large_parked",
  "large_poisoned",
  "pending_promotion",
  "exceeds_largest",
  "fits_small",
  "oldest_unresolved_age_ms",
  "refusals_total",
  "routed_total",
  "promoted_total",
  // P-084 (admission): the queued-job cap and the queue's reachability.
  "queue_full",
  "queue_unreachable",
] as const;
/**
 * capacity.py CAPACITY_REV_KEYS: the capacity line's revision (`rev`, a minor
 * version under the same schema string) and the keys each revision ADDED. A
 * line or readiness `capacity` object without `rev` predates revisioning and
 * is revision 1. decodeCounts reads revisions 1..CAPACITY_REV + REV_FORWARD,
 * so a rolling deploy (old and new pollers logging at once) and retained log
 * history keep parsing on either side.
 */
export const CAPACITY_REV_KEYS: Record<number, readonly string[]> = {
  1: COUNT_KEYS.slice(0, 12),
  2: COUNT_KEYS.slice(12, 14), // queue_full, queue_unreachable (P-084)
};
export const CAPACITY_REV = Math.max(
  ...Object.keys(CAPACITY_REV_KEYS).map(Number)
);
export const REV_FORWARD = 8;
export const LARGE_COUNT_KEYS = [
  "busy",
  "queued",
  "skew",
  "allowlisted",
  "unfit",
  "refusal",
] as const;
const CAPACITY_HEAD = ["schema", "class", "role", "label"] as const;
export const REFUSALS = [
  "manifest_missing",
  "manifest_unreadable",
  "label",
  "skew",
  "budget",
] as const;

export const SCHEMA = "math_poller.readiness/1";
export const STALE_SCHEMA = "math_poller.discovery_stale/1";
export const CAPACITY_SCHEMA = "math_poller.capacity/1";
export const ROLES = ["primary", "standby"] as const;
export const PROGRESS = [
  "ok",
  "starting",
  "no_poll",
  "stale",
  "stuck",
  "waiting",
] as const;
export const ERROR_CLASSES = ["database", "timeout", "other"] as const;
export const SWEEP_STATUS = ["COMPLETE", "NOT_COMPLETE", "UNKNOWN"] as const;
const INSTANCE_SOURCES = ["instance_id", "hostname"];
const STALE_REASONS = ["discovery", "queue"];

// readiness.py _LINE and _STALE_LINE. The class token is optional; only the
// small (default) class is read here.
const LINE_RE =
  /math_poller (?:class=(\w+) )?(readiness|readiness_silenced)\/1 role=(\w+) progress=(\w+) (\{.*\})\s*$/;
const STALE_RE = /math_poller (?:class=(\w+) )?discovery_stale\/1 (\{.*\})\s*$/;
const IMAGE_RE = /^sha256:[0-9a-f]{64}$/;
const LABEL_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export type Json = Record<string, any>;

export type ReadinessLine = Json & {
  role: (typeof ROLES)[number];
  progress: (typeof PROGRESS)[number];
  silenced: boolean;
};

export class LineShapeError extends Error {}

function fail(what: string): never {
  throw new LineShapeError(what);
}

function closed(obj: unknown, keys: readonly string[]): asserts obj is Json {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) fail("object");
  const have = Object.keys(obj as Json).sort();
  const want = [...keys].sort();
  if (have.length !== want.length || have.some((k, i) => k !== want[i])) {
    fail(`keys ${want.join(",")}`);
  }
}

function count(v: unknown, nullable = false): void {
  if (v === null && nullable) return;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    fail("count");
  }
}

function hex(v: unknown, width: number, nullable = false): void {
  if (v === null && nullable) return;
  if (typeof v !== "string" || !new RegExp(`^[0-9a-f]{${width}}$`).test(v)) {
    fail(`hex${width}`);
  }
}

function oneOf(v: unknown, values: readonly string[], nullable = false): void {
  if (v === null && nullable) return;
  if (typeof v !== "string" || !values.includes(v)) fail("label");
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return fail("json");
  }
}

/** readiness.py validate_line. Throws LineShapeError. */
export function validateLine(body: unknown): asserts body is Json {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("object");
  const b = body as Json;
  const required: Json = {};
  for (const [k, v] of Object.entries(b)) {
    if (!(OPTIONAL_LINE_KEYS as readonly string[]).includes(k)) required[k] = v;
  }
  closed(required, LINE_KEYS);
  if (b.schema !== SCHEMA) fail("schema");
  oneOf(b.role, ROLES);
  oneOf(b.progress, PROGRESS);
  if ((b.role === "standby") !== (b.progress === "waiting")) fail("waiting");
  for (const k of ["seq", "emitted_ms", "interval_s", "stale_s"]) count(b[k]);
  hex(b.instance_sha256, 64);
  oneOf(b.instance_source, INSTANCE_SOURCES);
  if (b.image_digest !== null && !IMAGE_RE.test(String(b.image_digest))) {
    fail("image");
  }
  hex(b.source_commit, 40, true);
  hex(b.run, 12);
  hex(b.config, 12, true);
  hex(b.poller_config, 12);
  const d = b.discovery;
  closed(d, DISCOVERY_KEYS);
  for (const k of ["successes", "consecutive", "failures_since_success"]) {
    count(d[k]);
  }
  for (const k of ["last_success_ms", "last_success_age_ms", "last_error_ms"]) {
    count(d[k], true);
  }
  oneOf(d.last_error, ERROR_CLASSES, true);
  const q = b.queue;
  closed(q, QUEUE_KEYS);
  for (const k of ["pending", "in_flight", "parked", "oldest_work_age_ms"]) {
    count(q[k]);
  }
  for (const k of ["oldest_live_age_ms", "oldest_backfill_age_ms"]) {
    count(q[k], true);
  }
  if (b.sweep !== null) {
    const s = b.sweep;
    closed(s, SWEEP_KEYS);
    for (const k of [
      "sweep_no",
      "finished_ms",
      "unresolved",
      "parked_live",
      "in_flight",
    ]) {
      count(s[k]);
    }
    hex(s.run, 12);
    hex(s.config, 12);
    oneOf(s.status, SWEEP_STATUS);
  }
  if (b.drain !== null) {
    closed(b.drain, DRAIN_KEYS);
    hex(b.drain.run, 12);
    count(b.drain.drained_ms, true);
  }
  if (b.admission !== null) {
    closed(b.admission, ADMISSION_KEYS);
    for (const k of ADMISSION_KEYS) count(b.admission[k], k === "budget_mb");
  }
  if (b.capacity !== undefined && b.capacity !== null) {
    b.capacity = decodeCounts(b.capacity);
  }
}

/**
 * readiness.py parse_readiness for the small class: the body of a readiness
 * (or silenced) line, or null for any other line (another class included).
 * Throws LineShapeError for a readiness line that breaks the closed shape.
 */
export function parseReadiness(line: string): ReadinessLine | null {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const [, klass, kind, role, progress, raw] = m;
  if ((klass || "small") !== "small") return null;
  const body = parseJson(raw);
  validateLine(body);
  if (body.role !== role || body.progress !== progress) fail("header");
  return { ...body, silenced: kind === "readiness_silenced" } as ReadinessLine;
}

/** readiness.py parse_stale for the small class. */
export function parseStale(line: string): Json | null {
  const m = STALE_RE.exec(line);
  if (!m || (m[1] || "small") !== "small") return null;
  const body = parseJson(m[2]);
  closed(body, STALE_KEYS);
  if (body.schema !== STALE_SCHEMA) fail("schema");
  oneOf(body.reason, STALE_REASONS);
  return body;
}

/** capacity.py NULLABLE_COUNT_KEYS: null on a primary with nothing unresolved,
 * or with no queue read this tick (large_leased and large_parked, P-073 r2). */
const NULLABLE_COUNT_KEYS = [
  "oldest_unresolved_age_ms",
  "large_leased",
  "large_parked",
] as const;

const FORWARD_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** capacity.py keys_through: the count keys a line of revision `rev` carries. */
export function keysThrough(rev: number): string[] {
  return Object.keys(CAPACITY_REV_KEYS)
    .map(Number)
    .sort((a, b) => a - b)
    .filter((r) => r <= rev)
    .flatMap((r) => [...CAPACITY_REV_KEYS[r]]);
}

/**
 * capacity.py decode_counts: the counts of any revision 1..CAPACITY_REV +
 * REV_FORWARD, validated, as this parser's closed shape: every COUNT_KEYS key
 * (null where the line's older revision lacks it) plus `rev`. A newer
 * revision must still carry every key this parser knows; the keys it declared
 * beyond them are checked as counts and dropped, never relayed.
 */
export function decodeCounts(counts: unknown, nullable = false): Json {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    fail("object");
  }
  const c = counts as Json;
  const rev = "rev" in c ? c.rev : 1;
  if (
    typeof rev !== "number" ||
    !Number.isSafeInteger(rev) ||
    rev < 1 ||
    rev > CAPACITY_REV + REV_FORWARD
  ) {
    fail("rev");
  }
  const expected = keysThrough(rev);
  const have = Object.keys(c).filter((k) => k !== "rev");
  if (expected.some((k) => !have.includes(k)))
    fail(`keys ${expected.join(",")}`);
  const extra = have.filter((k) => !expected.includes(k));
  if (extra.length && rev <= CAPACITY_REV)
    fail(`undeclared ${extra.join(",")}`);
  for (const k of extra) {
    if (!FORWARD_KEY_RE.test(k)) fail("key");
    count(c[k], true);
  }
  for (const k of expected) {
    count(
      c[k],
      nullable || (NULLABLE_COUNT_KEYS as readonly string[]).includes(k)
    );
  }
  if (![null, 0, 1].includes(c.routing)) fail("routing");
  const out: Json = { rev };
  for (const k of COUNT_KEYS) out[k] = k in c ? c[k] : null;
  return out;
}

/** capacity.py validate_counts. */
export function validateCounts(counts: unknown, nullable = false): void {
  decodeCounts(counts, nullable);
}

/** capacity.py validate_large_counts. */
export function validateLargeCounts(counts: unknown, nullable = false): void {
  closed(counts, LARGE_COUNT_KEYS);
  for (const k of LARGE_COUNT_KEYS) {
    if (k === "refusal") {
      oneOf(counts[k], REFUSALS, true);
    } else {
      count(counts[k], nullable);
    }
  }
  if (![null, 0, 1].includes(counts.skew)) fail("skew");
}

/** capacity.py parse_line: a capacity line's body, or null for other lines. */
export function parseCapacity(line: string): Json | null {
  const text = line.trim();
  if (!text.startsWith("{") || !text.includes(CAPACITY_SCHEMA)) return null;
  const body = parseJson(text);
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Json;
  if (b.schema !== CAPACITY_SCHEMA) return null;
  oneOf(b.class, ["small", "large"]);
  oneOf(b.role, ROLES);
  const large = b.class === "large";
  if (typeof b.label !== "string") fail("label");
  const nullable = b.role !== "primary";
  // The label is a free string in the schema; only a plain label is shown.
  const head: Json = {
    schema: b.schema,
    class: b.class,
    role: b.role,
    label: LABEL_RE.test(b.label) ? b.label : "other",
  };
  if (large) {
    closed(b, [...CAPACITY_HEAD, ...LARGE_COUNT_KEYS]);
    const counts: Json = {};
    for (const k of LARGE_COUNT_KEYS) counts[k] = b[k];
    validateLargeCounts(counts, nullable);
    return { ...b, label: head.label };
  }
  const counts: Json = {};
  for (const [k, v] of Object.entries(b)) {
    if (!(CAPACITY_HEAD as readonly string[]).includes(k)) counts[k] = v;
  }
  return { ...head, ...decodeCounts(counts, nullable) };
}
