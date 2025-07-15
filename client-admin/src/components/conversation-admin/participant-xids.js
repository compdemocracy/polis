// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { useState, useEffect } from 'react'
import PropTypes from 'prop-types'
import { Heading, Link, Text } from 'theme-ui'
import Url from '../../util/url'
import { useAuth } from 'react-oidc-context'
import PolisNet from '../../util/net'

const { urlPrefix } = Url

const getCurrentTimestamp = () => {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

const getDownloadFilename = (conversation_id) => {
  return `${getCurrentTimestamp()}-${conversation_id}-xid.csv`
}

const ParticipantXids = ({ conversation_id }) => {
  const { isLoading, isAuthenticated } = useAuth()

  const [state, setState] = useState({
    conversationUuid: null,
    isLoading: true,
    error: null
  })

  const loadConversationUuid = () => {
    // Use PolisNet.polisGet to ensure proper authorization header
    PolisNet.polisGet('/api/v3/conversationUuid', {
      conversation_id: conversation_id
    })
      .then((data) => {
        setState({
          conversationUuid: data.conversation_uuid,
          isLoading: false,
          error: null
        })
      })
      .catch((error) => {
        console.error('Error fetching UUID:', error)
        setState({
          conversationUuid: null,
          error: 'Failed to fetch conversation UUID',
          isLoading: false
        })
      })
  }

  const loadConversationUuidIfNeeded = () => {
    // Only load if we have a conversation ID and Auth is ready (not loading)
    if (conversation_id && !isLoading && !state.conversationUuid) {
      loadConversationUuid()
    }
  }

  useEffect(() => {
    // Try to load conversation UUID when component mounts
    loadConversationUuidIfNeeded()
  }, [])

  useEffect(() => {
    // Try again if conversation_id changes or auth state changes
    loadConversationUuidIfNeeded()
  }, [conversation_id, isLoading, isAuthenticated])

  const { conversationUuid, isLoading: uuidLoading, error } = state

  // Only calculate these values if we have a UUID
  const downloadFilename = getDownloadFilename(conversation_id)

  return (
    <div>
      <Heading
        as="h3"
        sx={{
          fontSize: [3, null, 4],
          lineHeight: 'body',
          mb: [3, null, 4],
          display: 'block'
        }}>
        DOWNLOAD XID CSV
      </Heading>

      {uuidLoading ? (
        // Show loading indicator while fetching UUID
        <Text
          sx={{
            display: 'block',
            mb: [3]
          }}>
          Loading conversation UUID for XID download...
        </Text>
      ) : error ? (
        // Show error message if failed to fetch UUID
        <Text
          sx={{
            display: 'block',
            mb: [3],
            color: 'red'
          }}>
          Could not load conversation UUID for XID download
        </Text>
      ) : conversationUuid ? (
        // Only show download links if we have the UUID
        <>
          <Text
            sx={{
              display: 'block',
              mb: [2]
            }}>
            <a
              download={downloadFilename}
              href={`${urlPrefix}api/v3/xid/${conversationUuid}-xid.csv`}
              type="text/csv">
              xid csv download: {downloadFilename}
            </a>
          </Text>

          <Text
            sx={{
              display: 'block',
              mb: [3]
            }}>
            {`curl: ${urlPrefix}api/v3/xid/${conversationUuid}-xid.csv`}
          </Text>
        </>
      ) : (
        // Fallback message when UUID is null but no error occurred
        <Text
          sx={{
            display: 'block',
            mb: [3]
          }}>
          No conversation UUID available for XID download
        </Text>
      )}

      <Heading
        as="h3"
        sx={{
          fontSize: [3, null, 4],
          lineHeight: 'body',
          mb: [3, null, 4],
          mt: 4,
          display: 'block'
        }}>
        WHAT IS AN XID? GET UP AND RUNNING WITH PARTICIPANT IDENTITY!
      </Heading>

      <ul>
        <li>
          Sometimes, the{' '}
          <Link target="_blank" href="https://compdemocracy.org/owner">
            owner
          </Link>{' '}
          of a{' '}
          <Link target="_blank" href="https://compdemocracy.org/conversation">
            conversation
          </Link>{' '}
          has some existing linkage to the identity of their{' '}
          <Link target="_blank" href="https://compdemocracy.org/participant">
            participants
          </Link>
          , i.e., they are sending out an email campaign or people are participating behind a login
          wall where the conversation is embedded
        </li>

        <li>
          A note: using{' '}
          <Link target="_blank" href="https://compdemocracy.org/xid">
            xid
          </Link>{' '}
          assumes that the{' '}
          <Link target="_blank" href="https://compdemocracy.org/owners">
            owner
          </Link>{' '}
          has the token, this is different from{' '}
          <Link target="_blank" href="https://compdemocracy.org/creating-single-use-urls">
            creating single use urls
          </Link>
        </li>

        <li>
          <Link target="_blank" href="https://compdemocracy.org/xid">
            xid
          </Link>{' '}
          works in the embedded case — i.e., the{' '}
          <Link target="_blank" href="https://compdemocracy.org/owners">
            owner
          </Link>{' '}
          has added the{' '}
          <Link target="_blank" href="https://compdemocracy.org/embed-code">
            embed code
          </Link>{' '}
          to a page on their own web property
        </li>

        <li>
          Once the{' '}
          <Link target="_blank" href="https://compdemocracy.org/conversation">
            conversation
          </Link>{' '}
          has been embedded on a third party webpage, that page can, however it likes, via
          JavaScript or via templating for instance, add the data attribute{' '}
          <code>data-xid=&quot;test&quot;</code>
        </li>

        <li>
          The{' '}
          <Link target="_blank" href="https://compdemocracy.org/xid">
            xid
          </Link>{' '}
          value for each participant will be available on the participation record in the{' '}
          <Link target="_blank" href="https://compdemocracy.org/export">
            export
          </Link>
        </li>

        <li>
          <Link target="_blank" href="https://compdemocracy.org/xid">
            Example
          </Link>
          <ul>
            <li>
              A common workflow for using{' '}
              <Link target="_blank" href="https://compdemocracy.org/xid">
                xid
              </Link>{' '}
              involves a table of demographic data available from a polling provider
            </li>

            <li>
              <Link target="_blank" href="https://compdemocracy.org/participant">
                Participants
              </Link>{' '}
              are sent an email and invited to participate
            </li>

            <li>
              Then, when the{' '}
              <Link target="_blank" href="https://compdemocracy.org/participant">
                participant
              </Link>{' '}
              clicks through the email to a custom url, custom JavaScript written by whoever is
              controlling the third party website on which polis is embedded grabs a token out of
              the url and adds it to the
              <div sx={{ display: 'inline-block' }}>
                <code>data-xid=&quot;someTokenFromTheURLBarThatIdentifiesTheUser&quot;</code>
              </div>
            </li>
          </ul>
        </li>

        <li>Embed code parameter that allows login-less participation by known users</li>

        <li>
          Usage: <code>data-xid=&quot;guid&quot;</code>, or{' '}
          <code>data-xid=&quot;5647434556754623&quot;</code>, or less anonymously and not
          recommended <code>data-xid=&quot;foo@bar.com&quot;</code>
        </li>
      </ul>
    </div>
  )
}

ParticipantXids.propTypes = {
  conversation_id: PropTypes.string.isRequired
}

export default ParticipantXids
