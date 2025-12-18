import { submitVote } from '../votes'
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
      vote: 1
    }

    it('should submit vote with auto-detected language when lang not provided', async () => {
      mockedLang.uiLanguage.mockReturnValue('en-US')
      const mockResponse = { success: true }
      mockedPolisNet.polisPost.mockResolvedValue(mockResponse)

      const result = await submitVote(basePayload)

      expect(mockedLang.uiLanguage).toHaveBeenCalled()
      expect(mockedPolisNet.polisPost).toHaveBeenCalledWith('/votes', {
        ...basePayload,
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
        ...basePayload,
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
        ...basePayload,
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
        ...basePayload,
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
        ...basePayload,
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
        ...basePayload,
        tid: 'tid-string-123'
      })
      expect(result).toEqual(mockResponse)
    })

    it('should not include lang when auto-detect returns null', async () => {
      mockedLang.uiLanguage.mockReturnValue(null)
      const mockResponse = { success: true }
      mockedPolisNet.polisPost.mockResolvedValue(mockResponse)

      const result = await submitVote(basePayload)

      expect(mockedPolisNet.polisPost).toHaveBeenCalledWith('/votes', basePayload)
      expect(result).toEqual(mockResponse)
    })
  })
})
