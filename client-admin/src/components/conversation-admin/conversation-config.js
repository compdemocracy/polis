// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { useRef } from 'react'
import { useSelector, useDispatch } from 'react-redux'
import { handleZidMetadataUpdate, optimisticZidMetadataUpdateOnTyping } from '../../actions'
import ComponentHelpers from '../../util/component-helpers'
import NoPermission from './no-permission'
import { Heading, Box, Text } from 'theme-ui'
import emoji from 'react-easy-emoji'
import { CheckboxField } from './CheckboxField'
import ModerateCommentsSeed from './seed-comment'
import Spinner from '../framework/spinner'

const ConversationConfig = () => {
  const dispatch = useDispatch()
  const user = useSelector((state) => state.user)
  const { zid_metadata, loading, error } = useSelector((state) => state.zid_metadata)

  const topicRef = useRef(null)
  const descriptionRef = useRef(null)

  const handleStringValueChange = (field) => {
    return () => {
      let val = field === 'topic' ? topicRef.current.value : descriptionRef.current.value
      if (field === 'help_bgcolor' || field === 'help_color') {
        if (!val.length) {
          val = 'default'
        }
      }
      dispatch(handleZidMetadataUpdate(zid_metadata, field, val))
    }
  }

  const handleConfigInputTyping = (field) => {
    return (e) => {
      dispatch(optimisticZidMetadataUpdateOnTyping(zid_metadata, field, e.target.value))
    }
  }

  if (loading && !topicRef.current && !descriptionRef.current) {
    return <Spinner />
  }
  if (ComponentHelpers.shouldShowPermissionsError({ user, zid_metadata, loading })) {
    return <NoPermission />
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
            width: '35em',
            borderRadius: 2,
            padding: [2],
            border: '1px solid',
            borderColor: 'mediumGray'
          }}
          data-testid="topic"
          onBlur={handleStringValueChange('topic')}
          onChange={handleConfigInputTyping('topic')}
          defaultValue={zid_metadata.topic}
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
            width: '35em',
            height: '7em',
            resize: 'none',
            padding: [2],
            borderRadius: 2,
            border: '1px solid',
            borderColor: 'mediumGray'
          }}
          data-testid="description"
          onBlur={handleStringValueChange('description')}
          onChange={handleConfigInputTyping('description')}
          defaultValue={zid_metadata.description}
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
      <ModerateCommentsSeed params={{ conversation_id: zid_metadata.conversation_id }} />

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
