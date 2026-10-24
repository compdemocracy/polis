import { importErrorMessage } from './importError'
import { handleBulkSeedCommentSubmit, SUBMIT_SEED_COMMENT_ERROR } from '../actions'
import PolisNet from './net'

jest.mock('./net', () => ({ __esModule: true, default: { polisPost: jest.fn() } }))

const message = 'This conversation already has data; importing would overwrite it. Polis does not merge. Import into a new conversation instead.'
const refusal = { responseText: JSON.stringify({ error: 'polis_err_import_target_not_empty', message }) }

test('votes upload uses the server refusal message', () => {
  expect(importErrorMessage(refusal)).toBe(message)
  expect(importErrorMessage({ message: 'Other error' })).toBe('Other error')
})

test('bulk comment rejection reaches the visible error state without calling success', async () => {
  const error = { responseText: 'Upload failed' }
  PolisNet.polisPost.mockRejectedValueOnce(error)
  const dispatch = jest.fn()
  const complete = jest.fn()
  await handleBulkSeedCommentSubmit({ csv: 'comment_text\nExample' }, complete)(dispatch)
  expect(complete).not.toHaveBeenCalled()
  expect(dispatch).toHaveBeenLastCalledWith({ type: SUBMIT_SEED_COMMENT_ERROR, data: error })
})
