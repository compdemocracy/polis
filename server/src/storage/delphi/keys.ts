/**
 * Key construction and shared constants for Delphi Storage V2.
 *
 * TypeScript twin of delphi/delphi_storage/keys.py — the rules here are part
 * of the cross-language conformance contract
 * (delphi/delphi_storage/conformance/README.md); keep the two in sync.
 */
import { InvalidError } from "./errors";
import type { RunManifest } from "./interface";

export const ENTITY_RUNS = "runs";
export const ENTITY_RUN_INPUTS = "run_inputs";
export const ENTITY_ARTIFACTS = "artifacts";
export const ENTITY_LATEST = "latest";
export const ENTITY_TOPIC_MODERATION = "topic_moderation";
export const ENTITY_COLLECTIVE_STATEMENTS = "collective_statements";

/**
 * Entities addressable through the generic put/get/query/delete operations.
 * `runs` and `latest` are mutated exclusively through the semantic ops so
 * their invariants (optimistic lock, monotonic seq) cannot be bypassed.
 */
export const GENERIC_ENTITIES = [
  ENTITY_RUN_INPUTS,
  ENTITY_ARTIFACTS,
  ENTITY_TOPIC_MODERATION,
  ENTITY_COLLECTIVE_STATEMENTS,
] as const;

export type GenericEntity = (typeof GENERIC_ENTITIES)[number];

/**
 * Reserved for backend-internal chunk rows (DynamoDB 400KB item limit);
 * forbidden in user-supplied keys.
 */
export const CHUNK_MARKER = "\u007f";

export const LOG_PREFIX = "log#";

const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Validate the canonical timestamp format YYYY-MM-DDTHH:MM:SS.mmmZ. */
export function validateTs(ts: string): string {
  if (typeof ts !== "string" || !TS_RE.test(ts)) {
    throw new InvalidError(`timestamp must be YYYY-MM-DDTHH:MM:SS.mmmZ, got ${JSON.stringify(ts)}`);
  }
  if (Number.isNaN(Date.parse(ts))) {
    throw new InvalidError(`timestamp is not a real date: ${ts}`);
  }
  return ts;
}

export function nowTs(): string {
  // Date#toISOString always emits the canonical YYYY-MM-DDTHH:MM:SS.mmmZ form.
  return new Date().toISOString();
}

export function tsAddSeconds(ts: string, seconds: number): string {
  validateTs(ts);
  return new Date(Date.parse(ts) + seconds * 1000).toISOString();
}

/**
 * Compare strings by UTF-8 byte order (= Unicode code-point order, and
 * DynamoDB's native range-key order). NOT the same as JavaScript's default
 * `<` comparison, which uses UTF-16 code units and misorders astral-plane
 * characters relative to U+E000..U+FFFF.
 */
export function utf8Compare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Claim-order string: ascending sort = highest priority first, then FIFO,
 * then job_id as tiebreak.
 */
export function claimOrder(priority: number, enqueuedAt: string, jobId: string): string {
  const p = Math.min(Math.max(Math.trunc(priority), 0), 9999);
  return `${String(9999 - p).padStart(4, "0")}#${enqueuedAt}#${jobId}`;
}

export function scopeForZid(zid: number, jobType: string): string {
  return `zid#${zid}#${jobType}`;
}

export function scopeForRid(rid: number, jobType: string): string {
  return `rid#${rid}#${jobType}`;
}

/**
 * Latest-pointer scopes a completed run flips (design §4.2 entity 4).
 * IMPORTED runs never auto-flip: the backfill importer advances pointers
 * explicitly under the no-clobber invariant (design §6.2 invariant 1).
 */
export function scopesForRun(run: RunManifest): string[] {
  if (run.job_type === "FULL_PIPELINE") {
    if (run.zid === null || run.zid === undefined) {
      throw new InvalidError(`run ${run.job_id}: FULL_PIPELINE requires zid`);
    }
    return [scopeForZid(run.zid, run.job_type)];
  }
  if (run.job_type === "NARRATIVE_BATCH" || run.job_type === "SERVER_NARRATIVE") {
    if (run.rid === null || run.rid === undefined) {
      throw new InvalidError(`run ${run.job_id}: ${run.job_type} requires rid`);
    }
    return [scopeForRid(run.rid, run.job_type)];
  }
  if (run.job_type === "IMPORTED") {
    return [];
  }
  throw new InvalidError(`run ${run.job_id}: unknown job_type ${JSON.stringify(run.job_type)}`);
}

export function logSk(seq: number): string {
  return `${LOG_PREFIX}${String(seq).padStart(8, "0")}`;
}

/**
 * Compose an artifact sort key from parts using the existing '#' composite
 * convention (e.g. artifactKey('umap', 'topic', 0, 3)).
 */
export function artifactKey(...parts: Array<string | number>): string {
  const strs = parts.map((p) => String(p));
  for (const s of strs) {
    if (!s) throw new InvalidError("artifact key parts must be non-empty");
    if (s.includes(CHUNK_MARKER)) {
      throw new InvalidError("artifact key parts must not contain U+007F");
    }
  }
  return strs.join("#");
}
