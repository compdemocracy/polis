// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { Heading, Box, Text, Button } from 'theme-ui'
import { useRef, useState } from 'react'
import { useConversationData } from '../../util/conversation_data'
import ModerateCommentsSeed from './ModerateCommentSeed'
import Spinner from '../framework/Spinner'
import PolisNet from '../../util/net'

const BYODConfig = () => {
  const conversationData = useConversationData()
  const { loading } = conversationData
  const topicRef = useRef(null)
  const descriptionRef = useRef(null)
  // eslint-disable-next-line no-unused-vars
  const [onComplete, setOnComplete] = useState(false)
  const [importSuccessful, setImportSuccessful] = useState(false)
  const [voteSubmissionLoading, setVoteSubmissionLoading] = useState(false)
  const [voteSubmissionError, setVoteSubmissionError] = useState(null)
  const [csvText, setCsvText] = useState(undefined)
  const handleFileChange = (e) => {
    const file = e.target.files[0]
    // Check if file size is > 50MB (50 * 1024 * 1024 bytes)
    if (!file || file.size > 50 * 1024 * 1024) {
      alert('File is too big! Maximum size is 50MB.')
      return
    }

    const reader = new FileReader()
    reader.onload = (event) => {
      const text = event.target.result
      setCsvText(text)
    }
    reader.readAsText(file)
  }

  const handleSubmitVotesBulk = () => {
    setVoteSubmissionLoading(true)
    PolisNet.polisPost('/api/v3/votes-bulk', {
      csv: csvText,
      conversation_id: conversationData.conversation_id
    })
      .then(
        (res) => {
          setVoteSubmissionLoading(false)
          setCsvText(undefined)
          setImportSuccessful(true)
        },
        (err) => setVoteSubmissionError(err?.message)
      )
      .finally(() => setVoteSubmissionLoading(false))
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
      {importSuccessful ? (
        <Text sx={{ color: 'green' }}>
          Your import was successful. You will receive an email once the job is completed.
        </Text>
      ) : (
        <>
          <Box sx={{ mb: [4] }}>
            <Text>
              Import external conversation data (comments and votes) from external sources for
              reporting metrics. This function requires uploading two CSV files, one containing
              comments, and another containing votes. Comment upload must occur first. After a
              successful import job, you will recieve an email notifying you that the data is ready.
            </Text>
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
                Upload a CSV of votes. comment_id field MUST match original_id field in comments
                csv. Size limit 50MB
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
                vote_value MUST follow the pattern: 1 = agree, -1 = disagree, 0 = neutral/pass
                <br />
              </>
              <Box sx={{ mt: 2, display: 'block' }}>
                <input onChange={handleFileChange} type="file" id="csvFile" accept=".csv"></input>
                <Button
                  disabled={voteSubmissionLoading || !csvText}
                  onClick={handleSubmitVotesBulk}
                  data-testid="upload-csv-button">
                  Upload Votes
                </Button>
                <br />
                {voteSubmissionError ? (
                  <Text sx={{ color: 'red' }}>{voteSubmissionError}</Text>
                ) : null}
              </Box>
            </Box>
          </>
        </>
      )}
    </Box>
  )
}

export default BYODConfig
