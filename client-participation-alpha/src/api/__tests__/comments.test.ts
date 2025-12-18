import { fetchComments, fetchNextComment, submitComment } from '../comments'
import PolisNet from '../../lib/net'
import * as langModule from '../../lib/lang'

// Mock dependencies
jest.mock('../../lib/net')
jest.mock('../../lib/lang')

const mockedPolisNet = PolisNet as jest.Mocked<typeof PolisNet>
const mockedLang = langModule as jest.Mocked<typeof langModule>

describe('comments API', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('fetchComments', () => {
    it('should fetch comments with basic conversation_id', async () => {
      const mockComments = [{ tid: 1, txt: 'Comment 1' }]
      mockedPolisNet.polisGet.mockResolvedValue(mockComments)

      const result = await fetchComments('conv123')

      expect(mockedPolisNet.polisGet).toHaveBeenCalledWith('/comments', {
        conversation_id: 'conv123'
      })
      expect(result).toEqual(mockComments)
    })

    it('should include moderation param when true', async () => {
      const mockComments = [{ tid: 1, txt: 'Comment 1' }]
      mockedPolisNet.polisGet.mockResolvedValue(mockComments)

      await fetchComments('conv123', { moderation: true })

      expect(mockedPolisNet.polisGet).toHaveBeenCalledWith('/comments', {
        conversation_id: 'conv123',
        moderation: true
      })
    })

    it('should include moderation param when false', async () => {
      const mockComments = [{ tid: 1, txt: 'Comment 1' }]
      mockedPolisNet.polisGet.mockResolvedValue(mockComments)

      await fetchComments('conv123', { moderation: false })

      expect(mockedPolisNet.polisGet).toHaveBeenCalledWith('/comments', {
        conversation_id: 'conv123',
        moderation: false
      })
    })

    it('should include voting_patterns param when true', async () => {
      const mockComments = [{ tid: 1, txt: 'Comment 1' }]
      mockedPolisNet.polisGet.mockResolvedValue(mockComments)

      await fetchComments('conv123', { include_voting_patterns: true })

      expect(mockedPolisNet.polisGet).toHaveBeenCalledWith('/comments', {
        conversation_id: 'conv123',
        include_voting_patterns: true
      })
    })

    it('should include both optional params', async () => {
      const mockComments = [{ tid: 1, txt: 'Comment 1' }]
      mockedPolisNet.polisGet.mockResolvedValue(mockComments)

      await fetchComments('conv123', {
        moderation: false,
        include_voting_patterns: true
      })

      expect(mockedPolisNet.polisGet).toHaveBeenCalledWith('/comments', {
        conversation_id: 'conv123',
        moderation: false,
        include_voting_patterns: true
      })
    })
  })

  describe('fetchNextComment', () => {
    it('should fetch next comment with auto-detected language', async () => {
      mockedLang.uiLanguage.mockReturnValue('es')
      const mockResponse = { tid: 123, txt: 'Next comment' }
      mockedPolisNet.polisGet.mockResolvedValue(mockResponse)

      const result = await fetchNextComment('conv123')

      expect(mockedLang.uiLanguage).toHaveBeenCalled()
      expect(mockedPolisNet.polisGet).toHaveBeenCalledWith('/nextComment', {
        conversation_id: 'conv123',
        lang: 'es'
      })
      expect(result).toEqual(mockResponse)
    })

    it('should use provided language', async () => {
      const mockResponse = { tid: 123, txt: 'Next comment' }
      mockedPolisNet.polisGet.mockResolvedValue(mockResponse)

      const result = await fetchNextComment('conv123', 'fr')

      expect(mockedLang.uiLanguage).not.toHaveBeenCalled()
      expect(mockedPolisNet.polisGet).toHaveBeenCalledWith('/nextComment', {
        conversation_id: 'conv123',
        lang: 'fr'
      })
      expect(result).toEqual(mockResponse)
    })

    it('should not include lang when explicitly null', async () => {
      const mockResponse = { tid: 123, txt: 'Next comment' }
      mockedPolisNet.polisGet.mockResolvedValue(mockResponse)

      await fetchNextComment('conv123', null)

      expect(mockedLang.uiLanguage).not.toHaveBeenCalled()
      expect(mockedPolisNet.polisGet).toHaveBeenCalledWith('/nextComment', {
        conversation_id: 'conv123'
      })
    })

    it('should not include lang when auto-detect returns null', async () => {
      mockedLang.uiLanguage.mockReturnValue(null)
      const mockResponse = { tid: 123, txt: 'Next comment' }
      mockedPolisNet.polisGet.mockResolvedValue(mockResponse)

      await fetchNextComment('conv123')

      expect(mockedPolisNet.polisGet).toHaveBeenCalledWith('/nextComment', {
        conversation_id: 'conv123'
      })
    })

    it('should not include lang when explicitly empty string', async () => {
      const mockResponse = { tid: 123, txt: 'Next comment' }
      mockedPolisNet.polisGet.mockResolvedValue(mockResponse)

      await fetchNextComment('conv123', '')

      expect(mockedLang.uiLanguage).not.toHaveBeenCalled()
      expect(mockedPolisNet.polisGet).toHaveBeenCalledWith('/nextComment', {
        conversation_id: 'conv123'
      })
    })
  })

  describe('submitComment', () => {
    it('should submit comment with required fields', async () => {
      const mockResponse = { success: true }
      mockedPolisNet.polisPost.mockResolvedValue(mockResponse)

      const payload = {
        conversation_id: 'conv123',
        txt: 'My comment',
        pid: 456
      }

      const result = await submitComment(payload)

      expect(mockedPolisNet.polisPost).toHaveBeenCalledWith('/comments', payload)
      expect(result).toEqual(mockResponse)
    })

    it('should include optional fields when provided', async () => {
      const mockResponse = { success: true }
      mockedPolisNet.polisPost.mockResolvedValue(mockResponse)

      const payload = {
        conversation_id: 'conv123',
        txt: 'My comment',
        pid: 456,
        is_seed: true,
        vote: 1,
        agid: 789
      }

      await submitComment(payload)

      expect(mockedPolisNet.polisPost).toHaveBeenCalledWith('/comments', payload)
    })
  })
})
