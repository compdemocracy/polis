import { fireEvent, screen, waitFor } from '@testing-library/react'

import { ConversationDataProvider } from '../../util/conversation_data'
import { renderWithProviders } from '../../test-utils'
import ParticipantManagement, { settingErrorMessage } from './ParticipantManagement'
import PolisNet from '../../util/net'

jest.mock('../../util/net')

const conversationData = {
  conversation_id: 'test123',
  use_xid_whitelist: false,
  xid_required: false,
  loading: false,
  error: null
}

// What the network layer throws for a refused request: the status and the
// response body, as util/net attaches them.
const apiError = (status, body) => {
  const error = new Error(`Polis API Error: PUT /api/v3/conversations failed with status ${status}`)
  error.status = status
  error.responseText = JSON.stringify(body)
  return error
}

const whitelistFixed = () =>
  apiError(409, { error: 'polis_err_xid_whitelist_fixed_after_start', status: 409 })
const otherFailure = () => apiError(500, { error: 'polis_err_update_conversation', status: 500 })

const FIXED_MESSAGE =
  "This setting can't change once participants have joined. Start a new conversation to use a different setting."
const GENERIC_MESSAGE = "Couldn't save this change."

const renderPage = () =>
  renderWithProviders(
    <ConversationDataProvider>
      <ParticipantManagement />
    </ConversationDataProvider>,
    { preloadedState: { conversationData }, route: '/m/test123/participants' }
  )

describe('settingErrorMessage', () => {
  it('names the fixed-after-start refusal and nothing else', () => {
    expect(settingErrorMessage(null)).toBeNull()
    expect(settingErrorMessage(whitelistFixed())).toBe(FIXED_MESSAGE)
    expect(settingErrorMessage(otherFailure())).toBe(GENERIC_MESSAGE)
    expect(settingErrorMessage(new Error('network down'))).toBe(GENERIC_MESSAGE)
  })
})

describe('ParticipantManagement settings', () => {
  let consoleError

  beforeEach(() => {
    jest.clearAllMocks()
    PolisNet.polisGet.mockResolvedValue({ xids: [], pagination: null })
    // The store keeps the thrown Error object; the warning about it is expected.
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  it('explains why the allow list setting cannot change after participants have joined', async () => {
    PolisNet.polisPut.mockRejectedValue(whitelistFixed())
    renderPage()

    fireEvent.click(screen.getByTestId('use_xid_whitelist'))

    expect(await screen.findByTestId('use_xid_whitelist_error')).toHaveTextContent(FIXED_MESSAGE)
    expect(PolisNet.polisPut).toHaveBeenCalledWith(
      '/api/v3/conversations',
      expect.objectContaining({ use_xid_whitelist: true })
    )
    // The setting keeps the value the server holds.
    expect(screen.getByTestId('use_xid_whitelist')).not.toBeChecked()
    expect(screen.queryByText(/polis_err/)).not.toBeInTheDocument()
  })

  it('shows a plain message, with no technical detail, for any other failure', async () => {
    PolisNet.polisPut.mockRejectedValue(otherFailure())
    renderPage()

    fireEvent.click(screen.getByTestId('use_xid_whitelist'))

    expect(await screen.findByTestId('use_xid_whitelist_error')).toHaveTextContent(GENERIC_MESSAGE)
    expect(screen.queryByText(FIXED_MESSAGE)).not.toBeInTheDocument()
    expect(screen.queryByText(/polis_err|500|Polis API Error/)).not.toBeInTheDocument()
  })

  it('shows the message under the setting that was changed', async () => {
    PolisNet.polisPut.mockRejectedValue(otherFailure())
    renderPage()

    fireEvent.click(screen.getByTestId('xid_required'))

    expect(await screen.findByTestId('xid_required_error')).toHaveTextContent(GENERIC_MESSAGE)
    expect(screen.queryByTestId('use_xid_whitelist_error')).not.toBeInTheDocument()
  })

  it('shows nothing when the change is saved, and clears an earlier message', async () => {
    PolisNet.polisPut
      .mockRejectedValueOnce(whitelistFixed())
      .mockResolvedValueOnce({ ...conversationData, use_xid_whitelist: true })
    renderPage()
    const checkbox = screen.getByTestId('use_xid_whitelist')

    fireEvent.click(checkbox)
    await screen.findByTestId('use_xid_whitelist_error')

    fireEvent.click(checkbox)
    await waitFor(() => {
      expect(screen.queryByTestId('use_xid_whitelist_error')).not.toBeInTheDocument()
    })
    expect(checkbox).toBeChecked()
  })
})
