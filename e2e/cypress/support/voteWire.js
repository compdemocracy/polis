/**
 * The numeric vote wire, as the e2e suite sees it.
 *
 * POST /api/v3/votes and POST /api/v3/comments carry `vote` as a number:
 * the three constants below. The wire is frozen (P-078 ruling
 * R-wire): it never flips, whatever the server stores. Specs name a vote
 * ('agree' | 'disagree' | 'pass') and convert here; no spec writes the number.
 */

export const WIRE_AGREE = -1
export const WIRE_DISAGREE = 1
export const WIRE_PASS = 0

export const AGREE = 'agree'
export const DISAGREE = 'disagree'
export const PASS = 'pass'

const SEMANTIC_TO_WIRE = Object.freeze({
  [AGREE]: WIRE_AGREE,
  [DISAGREE]: WIRE_DISAGREE,
  [PASS]: WIRE_PASS,
})

/** 'agree' | 'disagree' | 'pass' -> the wire number. Throws on anything else. */
export function toWire(semantic) {
  if (!Object.prototype.hasOwnProperty.call(SEMANTIC_TO_WIRE, semantic)) {
    throw new Error(`voteWire.toWire: not a vote: ${String(semantic)}`)
  }
  return SEMANTIC_TO_WIRE[semantic]
}

/** A wire number -> 'agree' | 'disagree' | 'pass', or null (strict, no coercion). */
export function fromWire(value) {
  if (value === WIRE_AGREE) return AGREE
  if (value === WIRE_DISAGREE) return DISAGREE
  if (value === WIRE_PASS) return PASS
  return null
}

/**
 * Assert that an intercepted POST /votes (or /comments) carried `semantic` on
 * the wire: the body's number is exactly the wire value and decodes back to it.
 * @param {object} interception - a cy.wait() interception
 * @param {'agree'|'disagree'|'pass'} semantic
 */
export function expectVoteBody(interception, semantic) {
  const body = interception.request.body || {}
  expect(body.vote, `wire vote for ${semantic}`).to.eq(toWire(semantic))
  expect(fromWire(body.vote), 'decoded wire vote').to.eq(semantic)
}
