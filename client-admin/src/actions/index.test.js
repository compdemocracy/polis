import PolisNet from '../util/net'
import {
  handleBulkSeedCommentSubmit,
  SUBMIT_SEED_COMMENT,
  SUBMIT_SEED_COMMENT_SUCCESS,
  SUBMIT_SEED_COMMENT_ERROR
} from './index'

jest.mock('../util/net', () => ({
  __esModule: true,
  default: {
    polisPost: jest.fn()
  }
}))

describe('handleBulkSeedCommentSubmit', () => {
  const payload = { csv: 'comment_text\nOne', conversation_id: 'abc', is_seed: true }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('dispatches success and calls the callback when the upload succeeds', async () => {
    PolisNet.polisPost.mockResolvedValue({ ok: true })
    const dispatch = jest.fn()
    const cb = jest.fn()

    await handleBulkSeedCommentSubmit(payload, cb)(dispatch)

    expect(PolisNet.polisPost).toHaveBeenCalledWith('/api/v3/comments-bulk', payload)
    expect(dispatch).toHaveBeenCalledWith({ type: SUBMIT_SEED_COMMENT })
    expect(dispatch).toHaveBeenCalledWith({ type: SUBMIT_SEED_COMMENT_SUCCESS })
    expect(cb).toHaveBeenCalled()
  })

  it('dispatches an error when the upload fails, so the form stops loading', async () => {
    const err = new Error('Polis API Error')
    err.responseText = 'polis_err_post_comment'
    err.status = 500
    PolisNet.polisPost.mockRejectedValue(err)
    const dispatch = jest.fn()
    const cb = jest.fn()

    await handleBulkSeedCommentSubmit(payload, cb)(dispatch)

    expect(dispatch).toHaveBeenCalledWith({ type: SUBMIT_SEED_COMMENT })
    expect(dispatch).toHaveBeenCalledWith({ type: SUBMIT_SEED_COMMENT_ERROR, data: err })
    expect(cb).not.toHaveBeenCalled()
  })
})
