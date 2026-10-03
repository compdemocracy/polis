import { WIRE_AGREE, WIRE_DISAGREE, WIRE_PASS, fromWire, submitVote, type Vote } from '../votes'
import PolisNet from '../../lib/net'
import * as langModule from '../../lib/lang'

// Mock dependencies
jest.mock('../../lib/net')
jest.mock('../../lib/lang')

const mockedPolisNet = PolisNet as jest.Mocked<typeof PolisNet>
const mockedLang = langModule as jest.Mocked<typeof langModule>

describe('votes API', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('submitVote', () => {
    const basePayload = {
      agid: 1,
      conversation_id: 'conv123',
      pid: 456,
      tid: 789,
      vote: 'agree' as Vote
    }
    // What goes on the wire: the same payload with the vote as its wire number.
    const baseWire = { ...basePayload, vote: WIRE_AGREE }

    it('should submit vote with auto-detected language when lang not provided', async () => {
      mockedLang.uiLanguage.mockReturnValue('en-US')
      const mockResponse = { success: true }
      mockedPolisNet.polisPost.mockResolvedValue(mockResponse)

      const result = await submitVote(basePayload)

      expect(mockedLang.uiLanguage).toHaveBeenCalled()
      expect(mockedPolisNet.polisPost).toHaveBeenCalledWith('/votes', {
        ...baseWire,
        lang: 'en-US'
      })
      expect(result).toEqual(mockResponse)
    })

    it('should use provided language when explicitly set', async () => {
      const mockResponse = { success: true }
      mockedPolisNet.polisPost.mockResolvedValue(mockResponse)

      const result = await submitVote({ ...basePayload, lang: 'fr' })

      expect(mockedLang.uiLanguage).not.toHaveBeenCalled()
      expect(mockedPolisNet.polisPost).toHaveBeenCalledWith('/votes', {
        ...baseWire,
        lang: 'fr'
      })
      expect(result).toEqual(mockResponse)
    })

    it('should include null lang when explicitly set to null', async () => {
      const mockResponse = { success: true }
      mockedPolisNet.polisPost.mockResolvedValue(mockResponse)

      const result = await submitVote({ ...basePayload, lang: null })

      expect(mockedLang.uiLanguage).not.toHaveBeenCalled()
      expect(mockedPolisNet.polisPost).toHaveBeenCalledWith('/votes', {
        ...baseWire,
        lang: null
      })
      expect(result).toEqual(mockResponse)
    })

    it('should include empty lang when explicitly set to empty string', async () => {
      const mockResponse = { success: true }
      mockedPolisNet.polisPost.mockResolvedValue(mockResponse)

      const result = await submitVote({ ...basePayload, lang: '' })

      expect(mockedLang.uiLanguage).not.toHaveBeenCalled()
      expect(mockedPolisNet.polisPost).toHaveBeenCalledWith('/votes', {
        ...baseWire,
        lang: ''
      })
      expect(result).toEqual(mockResponse)
    })

    it('should include high_priority when provided', async () => {
      mockedLang.uiLanguage.mockReturnValue(null)
      const mockResponse = { success: true }
      mockedPolisNet.polisPost.mockResolvedValue(mockResponse)

      const result = await submitVote({ ...basePayload, high_priority: true })

      expect(mockedPolisNet.polisPost).toHaveBeenCalledWith('/votes', {
        ...baseWire,
        high_priority: true
      })
      expect(result).toEqual(mockResponse)
    })

    it('should handle string tid values', async () => {
      mockedLang.uiLanguage.mockReturnValue(null)
      const mockResponse = { success: true }
      mockedPolisNet.polisPost.mockResolvedValue(mockResponse)

      const result = await submitVote({ ...basePayload, tid: 'tid-string-123' })

      expect(mockedPolisNet.polisPost).toHaveBeenCalledWith('/votes', {
        ...baseWire,
        tid: 'tid-string-123'
      })
      expect(result).toEqual(mockResponse)
    })

    it('should not include lang when auto-detect returns null', async () => {
      mockedLang.uiLanguage.mockReturnValue(null)
      const mockResponse = { success: true }
      mockedPolisNet.polisPost.mockResolvedValue(mockResponse)

      const result = await submitVote(basePayload)

      expect(mockedPolisNet.polisPost).toHaveBeenCalledWith('/votes', baseWire)
      expect(result).toEqual(mockResponse)
    })

    it.each([
      ['agree', WIRE_AGREE],
      ['disagree', WIRE_DISAGREE],
      ['pass', WIRE_PASS]
    ] as const)('posts %s as its wire number', async (vote, wire) => {
      mockedLang.uiLanguage.mockReturnValue(null)
      mockedPolisNet.polisPost.mockResolvedValue({})

      await submitVote({ ...basePayload, vote })

      const [, body] = mockedPolisNet.polisPost.mock.calls[0] as [string, { vote: number }]
      expect(body.vote).toBe(wire)
      expect(fromWire(body.vote)).toBe(vote)
    })

    it('refuses a value that is not a semantic vote', async () => {
      await expect(
        submitVote({ ...basePayload, vote: WIRE_AGREE as unknown as Vote })
      ).rejects.toThrow(/not a vote/)
      expect(mockedPolisNet.polisPost).not.toHaveBeenCalled()
    })
  })
})
