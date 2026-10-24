import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeUIProvider } from 'theme-ui'

import ModerateCommentsSeed from './ModerateCommentSeed'
import seedComments from '../../reducers/seed_comments'
import PolisNet from '../../util/net'
import theme from '../../theme'

jest.mock('../../util/net', () => ({
  __esModule: true,
  default: { polisPost: jest.fn() }
}))

const csv = 'comment_text\nA seed comment for the upload test'

const prepareUpload = async (onComplete) => {
  const store = configureStore({ reducer: { seed_comments: seedComments } })
  render(
    <ThemeUIProvider theme={theme}>
      <Provider store={store}>
        <ModerateCommentsSeed
          params={{
            conversation_id: 'test-conversation',
            uploadOnly: true,
            setOnComplete: onComplete
          }}
        />
      </Provider>
    </ThemeUIProvider>
  )

  const button = screen.getByTestId('upload-csv-button')
  expect(button).toBeDisabled()
  fireEvent.change(document.getElementById('csvFile'), {
    target: { files: [new File([csv], 'seed-comments.csv', { type: 'text/csv' })] }
  })
  await waitFor(() => expect(button).toBeEnabled())
  return { button, store }
}

describe('seed CSV upload with real actions and reducer', () => {
  beforeEach(() => {
    jest.resetAllMocks()
  })

  it.each([
    [500, 'The seed CSV could not be imported.'],
    [
      400,
      JSON.stringify({
        error: 'polis_err_csv_header',
        message: 'CSV header must be comment_text, optionally with original_id.',
        status: 400
      })
    ]
  ])(
    'shows a %s error, re-enables submission, and allows a successful retry',
    async (status, responseText) => {
      let rejectUpload
      PolisNet.polisPost.mockReturnValueOnce(
        new Promise((resolve, reject) => {
          rejectUpload = reject
        })
      )
      const onComplete = jest.fn()
      const { button, store } = await prepareUpload(onComplete)

      fireEvent.click(button)
      expect(button).toBeDisabled()
      expect(button).toHaveTextContent('Saving...')
      expect(PolisNet.polisPost).toHaveBeenCalledWith('/api/v3/comments-bulk', {
        csv,
        conversation_id: 'test-conversation',
        is_seed: true
      })

      await act(async () => {
        rejectUpload({ status, responseText })
      })

      expect(screen.getByText(responseText)).toBeInTheDocument()
      expect(button).toBeEnabled()
      expect(button).toHaveTextContent('Submit')
      expect(store.getState().seed_comments).toMatchObject({
        loading: false,
        error: responseText,
        success: false
      })
      expect(onComplete).not.toHaveBeenCalled()

      PolisNet.polisPost.mockResolvedValueOnce({})
      fireEvent.click(button)
      expect(screen.queryByText(responseText)).not.toBeInTheDocument()
      await waitFor(() => expect(button).toHaveTextContent('Success!'))
      expect(button).toBeEnabled()
      expect(PolisNet.polisPost).toHaveBeenCalledTimes(2)
      expect(onComplete).toHaveBeenCalledTimes(1)
    }
  )

  it.each([true, false])(
    'completes a successful upload (callback provided: %s)',
    async (withCallback) => {
      let resolveUpload
      PolisNet.polisPost.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveUpload = resolve
        })
      )
      const onComplete = withCallback ? jest.fn() : undefined
      const { button, store } = await prepareUpload(onComplete)

      fireEvent.click(button)
      expect(button).toBeDisabled()
      expect(button).toHaveTextContent('Saving...')
      if (onComplete) expect(onComplete).not.toHaveBeenCalled()

      await act(async () => {
        resolveUpload({})
      })

      expect(button).toHaveTextContent('Success!')
      expect(button).toBeEnabled()
      expect(store.getState().seed_comments).toMatchObject({
        loading: false,
        error: false,
        success: true
      })
      if (onComplete) expect(onComplete).toHaveBeenCalledTimes(1)
    }
  )
})
