import type { VoteResponse } from '../components/types'
import { uiLanguage } from '../lib/lang'
import PolisNet from '../lib/net'

// The numeric vote wire, owned here and nowhere else in this client.
//
// POST /votes and POST /comments carry `vote` as a number: agree = -1,
// disagree = +1, pass = 0. The wire is frozen (P-078 ruling R-wire): it never
// flips, whatever the server stores, so this client never sees storage.
// Everything else in the client speaks the semantic `Vote` and converts here.

export type Vote = 'agree' | 'disagree' | 'pass'

export const WIRE_AGREE = -1 as const
export const WIRE_DISAGREE = 1 as const
export const WIRE_PASS = 0 as const

export type WireVote = typeof WIRE_AGREE | typeof WIRE_DISAGREE | typeof WIRE_PASS

export const VOTES: readonly Vote[] = Object.freeze(['agree', 'disagree', 'pass'] as const)

const SEMANTIC_TO_WIRE: Readonly<Record<Vote, WireVote>> = Object.freeze({
  agree: WIRE_AGREE,
  disagree: WIRE_DISAGREE,
  pass: WIRE_PASS
})

// The server encodes participant vote vectors (`famous`, ptptoi `votes`) as one
// letter per comment: a = agree, d = disagree, p = pass, u = unseen.
const LETTER_TO_VOTE: Readonly<Record<string, Vote>> = Object.freeze({
  a: 'agree',
  d: 'disagree',
  p: 'pass'
})
export const LETTER_UNSEEN = 'u'

export function isVote(value: unknown): value is Vote {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SEMANTIC_TO_WIRE, value)
}

/** A semantic vote -> its wire number. Throws on anything that is not a `Vote`. */
export function toWire(vote: Vote): WireVote {
  if (!isVote(vote)) {
    throw new Error(`votes.toWire: not a vote: ${String(vote)}`)
  }
  return SEMANTIC_TO_WIRE[vote]
}

/** A wire number -> its semantic vote, or null for anything else (strict, no coercion). */
export function fromWire(value: unknown): Vote | null {
  if (value === WIRE_AGREE) return 'agree'
  if (value === WIRE_DISAGREE) return 'disagree'
  if (value === WIRE_PASS) return 'pass'
  return null
}

/** A vote-vector letter -> its semantic vote, or null for unseen ('u') and unknown letters. */
export function fromLetter(letter: unknown): Vote | null {
  return typeof letter === 'string' && Object.prototype.hasOwnProperty.call(LETTER_TO_VOTE, letter)
    ? LETTER_TO_VOTE[letter]
    : null
}

export async function submitVote(payload: {
  agid: number
  conversation_id: string
  high_priority?: boolean
  lang?: string
  pid: number
  tid: number | string
  vote: Vote
}): Promise<VoteResponse> {
  // Auto-detect language only if not provided (undefined)
  // If lang is null or blank, don't auto-detect
  const lang = payload.lang !== undefined ? payload.lang : uiLanguage()
  const finalPayload = {
    ...payload,
    vote: toWire(payload.vote),
    ...(lang && { lang })
  }
  return await PolisNet.polisPost<VoteResponse>('/votes', finalPayload)
}
