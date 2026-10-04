/**
 * The numeric vote wire, for the integration tests that post votes.
 *
 * POST /api/v3/votes and POST /api/v3/comments carry `vote` as a number:
 * the three constants below. The wire is frozen (P-078 ruling
 * R-wire). Tests name a vote and convert here; none writes the number. When
 * the server's own convention module lands, this file re-exports from it.
 */
export type Vote = "agree" | "disagree" | "pass";

export const WIRE_AGREE = -1 as const;
export const WIRE_DISAGREE = 1 as const;
export const WIRE_PASS = 0 as const;

export type WireVote =
  | typeof WIRE_AGREE
  | typeof WIRE_DISAGREE
  | typeof WIRE_PASS;

const SEMANTIC_TO_WIRE: Readonly<Record<Vote, WireVote>> = Object.freeze({
  agree: WIRE_AGREE,
  disagree: WIRE_DISAGREE,
  pass: WIRE_PASS,
});

/** A semantic vote -> its wire number. */
export function toWire(vote: Vote): WireVote {
  return SEMANTIC_TO_WIRE[vote];
}

/** A wire number -> its semantic vote, or null (strict, no coercion). */
export function fromWire(value: unknown): Vote | null {
  if (value === WIRE_AGREE) return "agree";
  if (value === WIRE_DISAGREE) return "disagree";
  if (value === WIRE_PASS) return "pass";
  return null;
}
