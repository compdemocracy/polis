import {
  LETTER_UNSEEN,
  VOTES,
  WIRE_AGREE,
  WIRE_DISAGREE,
  WIRE_PASS,
  fromLetter,
  fromWire,
  isVote,
  toWire
} from '../votes'

// The module also holds submitVote; its transport is not exercised here.
jest.mock('../../lib/net')
jest.mock('../../lib/lang')

// The frozen numeric wire (P-078 ruling R-wire). This is the one pin of the
// three numbers outside the module itself; every other test names them.
describe('the frozen wire', () => {
  it('is agree -1, disagree 1, pass 0', () => {
    expect({ AGREE: WIRE_AGREE, DISAGREE: WIRE_DISAGREE, PASS: WIRE_PASS }).toEqual({
      AGREE: -1,
      DISAGREE: 1,
      PASS: 0
    })
  })
})

describe('vote wire round trips', () => {
  it('names the three semantic votes', () => {
    expect([...VOTES]).toEqual(['agree', 'disagree', 'pass'])
    expect(Object.isFrozen(VOTES)).toBe(true)
  })

  it.each(VOTES)('semantic %s -> wire -> semantic', (vote) => {
    expect(fromWire(toWire(vote))).toBe(vote)
  })

  it.each([WIRE_AGREE, WIRE_DISAGREE, WIRE_PASS])('wire %d -> semantic -> wire', (wire) => {
    const vote = fromWire(wire)
    expect(vote).not.toBeNull()
    expect(toWire(vote!)).toBe(wire)
  })

  it('maps each semantic vote to its named wire constant', () => {
    expect(toWire('agree')).toBe(WIRE_AGREE)
    expect(toWire('disagree')).toBe(WIRE_DISAGREE)
    expect(toWire('pass')).toBe(WIRE_PASS)
  })

  it('toWire refuses anything that is not a semantic vote', () => {
    for (const bad of [undefined, null, '', 'Agree', 'a', 'constructor', WIRE_AGREE]) {
      expect(() => toWire(bad as never)).toThrow(/not a vote/)
      expect(isVote(bad)).toBe(false)
    }
  })

  it('fromWire is strict: only the three wire numbers decode', () => {
    for (const bad of [undefined, null, NaN, 2, 0.5, '0', String(WIRE_AGREE), true, false]) {
      expect(fromWire(bad)).toBeNull()
    }
  })
})

describe('the a/d/p letter decoder (famous and ptptoi vectors)', () => {
  it('decodes a, d and p', () => {
    expect(fromLetter('a')).toBe('agree')
    expect(fromLetter('d')).toBe('disagree')
    expect(fromLetter('p')).toBe('pass')
  })

  it('returns null for unseen and for any other letter', () => {
    expect(LETTER_UNSEEN).toBe('u')
    for (const bad of ['u', 'A', 'x', '', undefined, null, 'constructor', 'toString']) {
      expect(fromLetter(bad)).toBeNull()
    }
  })

  it('decodes a whole vector to wire numbers through the semantic names', () => {
    const decoded = [...'adpu'].map((letter) => {
      const vote = fromLetter(letter)
      return vote ? toWire(vote) : null
    })
    expect(decoded).toEqual([WIRE_AGREE, WIRE_DISAGREE, WIRE_PASS, null])
  })
})
