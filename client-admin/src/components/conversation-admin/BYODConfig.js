// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { Heading, Box, Text, Button } from 'theme-ui'
import { useCallback, useRef, useState } from 'react'
import { useDispatch } from 'react-redux'
import emoji from 'react-easy-emoji'
import { useConversationData } from '../../util/conversation_data'
import strings from '../../strings/strings'
import ModerateCommentsSeed from './ModerateCommentSeed'
import Spinner from '../framework/Spinner'
import {
  handleConversationDataUpdate,
  optimisticConversationDataUpdateOnTyping
} from '../../actions'
import PolisNet from '../../util/net'

const BYODConfig = () => {
  const dispatch = useDispatch()
  const conversationData = useConversationData()
  const { loading, error } = conversationData
  const topicRef = useRef(null)
  const descriptionRef = useRef(null)
  const [onComplete, setOnComplete] = useState(false)
  const [voteSubmissionLoading, setVoteSubmissionLoading] = useState(false)
  const [voteSubmissionError, setVoteSubmissionError] = useState(null)
  const [csvText, setCsvText] = useState(undefined)
  const handleFileChange = (e) => {
    const file = e.target.files[0]
    if (!file) {
      return
    }

    const reader = new FileReader()
    reader.onload = (event) => {
      const text = event.target.result
      setCsvText(text)
    }
    reader.readAsText(file)
  }

  const handleStringValueChange = useCallback(
    (field, value) => {
      let val = value
      if (field === 'help_bgcolor' || field === 'help_color') {
        if (!val.length) {
          val = 'default'
        }
      }
      dispatch(handleConversationDataUpdate(conversationData, field, val))
    },
    [dispatch, conversationData]
  )

  const handleConfigInputTyping = useCallback(
    (field, value) => {
      dispatch(optimisticConversationDataUpdateOnTyping(conversationData, field, value))
    },
    [dispatch, conversationData]
  )

  const handleSubmitVotesBulk = () => {
    PolisNet.polisPost('/api/v3/comments-bulk', {
      csv: csvText,
      conversation_id: conversationData.conversation_id
    }).then(
      (res) => setVoteSubmissionLoading(false),
      (err) => setVoteSubmissionError(err)
    )
  }

  if (loading && !topicRef.current && !descriptionRef.current) {
    return <Spinner />
  }

  return (
    <Box>
      <Heading
        as="h3"
        sx={{
          fontSize: [3, null, 4],
          lineHeight: 'body',
          mb: [3, null, 4]
        }}>
        Import
      </Heading>
      <Box sx={{ mb: [4] }}>
        {loading ? <Text>{emoji('💾')} Saving</Text> : <Text>{emoji('⚡')} Up to date</Text>}
        {error ? <Text>Error Saving</Text> : null}
      </Box>

      <Box sx={{ mb: [4] }}>
        <Text>
          Import external conversation data (comments and votes) from external sources for reporting
          metrics. This function requires uploading two CSV files, one containing comments, and
          another containing votes. Comment upload must occur first. After a successful import job,
          you will recieve an email notifying you that the data is ready.
        </Text>
      </Box>

      <Box sx={{ mb: [3] }}>
        <Text sx={{ display: 'block', mb: [2] }}>Topic</Text>
        <input
          ref={topicRef}
          sx={{
            display: 'block',
            fontFamily: 'body',
            fontSize: [2],
            width: ['100%', '100%', '35em'],
            maxWidth: ['100%', '100%', '35em'],
            borderRadius: 2,
            padding: [2],
            border: '1px solid',
            borderColor: 'mediumGray'
          }}
          data-testid="topic"
          onBlur={(e) => handleStringValueChange('topic', e.target.value)}
          onChange={(e) => handleConfigInputTyping('topic', e.target.value)}
          value={conversationData.topic || ''}
        />
      </Box>

      <Box sx={{ mb: [3] }}>
        <Text sx={{ display: 'block', mb: [2] }}>Description</Text>
        <textarea
          ref={descriptionRef}
          sx={{
            display: 'block',
            fontFamily: 'body',
            fontSize: [2],
            width: ['100%', '100%', '35em'],
            maxWidth: ['100%', '100%', '35em'],
            height: '7em',
            resize: 'none',
            padding: [2],
            borderRadius: 2,
            border: '1px solid',
            borderColor: 'mediumGray'
          }}
          data-testid="description"
          onBlur={(e) => handleStringValueChange('description', e.target.value)}
          onChange={(e) => handleConfigInputTyping('description', e.target.value)}
          value={conversationData.description || ''}
        />
      </Box>

      <Heading
        as="h6"
        sx={{
          fontSize: [1, null, 2],
          lineHeight: 'body',
          my: [3, null, 4]
        }}>
        Import Comments
      </Heading>
      <ModerateCommentsSeed
        params={{
          conversation_id: conversationData.conversation_id,
          uploadOnly: true,
          setOnComplete: () => setOnComplete(true)
        }}
      />
      <>
        <Box sx={{ mt: 2, display: 'block' }}>
          <Heading
            as="h6"
            sx={{
              fontSize: [1, null, 2],
              lineHeight: 'body',
              my: [3, null, 4]
            }}>
            Upload a CSV of votes. comment_id field MUST match original_id field in comments csv.
          </Heading>
          <>
            CSV Format:
            <pre>
              <code>
                vote_id,user_id,vote_value,timestamp,comment_id
                <br />
                b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22,user_beta,-1,2025-01-01T10:05:00Z,550e8400-e29b-41d4-a716-446655440000
                <br />
                c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33,user_gamma,0,2025-01-01T10:10:00Z,550e8400-e29b-41d4-a716-446655440000
              </code>
            </pre>
            original_id MUST be a UUID.
          </>
          <input onChange={handleFileChange} type="file" id="csvFile" accept=".csv"></input>
          <Button
            disabled={voteSubmissionLoading || onComplete !== true}
            onClick={handleSubmitVotesBulk}
            data-testid="upload-csv-button">
            Upload Votes
          </Button>
          {voteSubmissionError ? <Text>{strings(voteSubmissionError)}</Text> : null}
        </Box>
      </>
    </Box>
  )
}

export default BYODConfig
