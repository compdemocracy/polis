// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { Heading, Box, Text } from 'theme-ui'
import { useCallback, useRef } from 'react'
import { useDispatch } from 'react-redux'
import emoji from 'react-easy-emoji'

import { CheckboxField } from './CheckboxField'
import { useConversationData } from '../../util/conversation_data'
import ModerateCommentsSeed from './ModerateCommentSeed'
import Spinner from '../framework/Spinner'
import {
  handleConversationDataUpdate,
  optimisticConversationDataUpdateOnTyping
} from '../../actions'

const ConversationConfig = () => {
  const dispatch = useDispatch()
  const conversationData = useConversationData()
  const { loading, error } = conversationData
  const topicRef = useRef(null)
  const descriptionRef = useRef(null)

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
        Configure
      </Heading>
      <Box sx={{ mb: [4] }}>
        {loading ? <Text>{emoji('💾')} Saving</Text> : <Text>{emoji('⚡')} Up to date</Text>}
        {error ? <Text>Error Saving</Text> : null}
      </Box>

      <CheckboxField field="is_active" label="Conversation Is Open">
        Conversation is open. Unchecking disables both voting and commenting.
      </CheckboxField>

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
        Seed Comments
      </Heading>
      <ModerateCommentsSeed params={{ conversation_id: conversationData.conversation_id }} />

      <Heading
        as="h6"
        sx={{
          fontSize: [1, null, 2],
          lineHeight: 'body',
          my: [3, null, 4]
        }}>
        Customize the user interface
      </Heading>

      <CheckboxField field="vis_type" label="Visualization" isIntegerBool>
        Participants can see the visualization
      </CheckboxField>

      <CheckboxField field="write_type" label="Comment form" isIntegerBool>
        Participants can submit comments
      </CheckboxField>

      <CheckboxField field="help_type" label="Help text" isIntegerBool>
        Show explanation text above voting and visualization
      </CheckboxField>

      <CheckboxField
        field="subscribe_type"
        label="Prompt participants to subscribe to updates"
        isIntegerBool>
        Prompt participants to subscribe to updates. A prompt is shown to users once they finish
        voting on all available comments. If enabled, participants may optionally provide their
        email address to receive notifications when there are new comments to vote on.
      </CheckboxField>

      <CheckboxField field="strict_moderation">
        No comments shown without moderator approval
      </CheckboxField>

      <CheckboxField field="treevite_enabled" label="Enable Invite Tree">
        [EXPERIMENTAL FEATURE] Enable Invite Tree. Nobody can participate without an invite. Invites
        are managed in waves.
      </CheckboxField>

      <CheckboxField field="importance_enabled" label="Importance Enabled">
        [EXPERIMENTAL FEATURE] Participants can see the &quot;This comment is important&quot;
        checkbox
      </CheckboxField>
    </Box>
  )
}

export default ConversationConfig
