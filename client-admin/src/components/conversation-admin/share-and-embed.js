// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import ConversationHasCommentsCheck from './conversation-has-comments-check'
import Url from '../../util/url'
import { useSelector } from 'react-redux'
import { Link, useParams } from 'react-router'
import { Heading, Text, Box } from 'theme-ui'
import ComponentHelpers from '../../util/component-helpers'
import NoPermission from './no-permission'
import ParticipantXids from './participant-xids'

const ShareAndEmbed = () => {
  const params = useParams()
  const zid_metadata = useSelector((state) => state.zid_metadata)

  const constructEmbeddedOnMarkup = () => {
    return (
      <p data-testid="embed-page">
        {'Embedded on: '}
        <a style={{ color: 'black' }} target="blank" href={zid_metadata.zid_metadata.parent_url}>
          {zid_metadata.zid_metadata.parent_url}
        </a>
      </p>
    )
  }

  if (
    ComponentHelpers.shouldShowPermissionsError({
      zid_metadata: zid_metadata.zid_metadata,
      loading: zid_metadata.loading
    })
  ) {
    return <NoPermission />
  }

  return (
    <div>
      <Heading
        as="h3"
        sx={{
          fontSize: [3, null, 4],
          lineHeight: 'body',
          mb: [3, null, 4]
        }}>
        Distribute
      </Heading>
      <ConversationHasCommentsCheck
        conversation_id={params.conversation_id}
        strict_moderation={zid_metadata.zid_metadata.strict_moderation}
      />
      <Box sx={{ mb: [3] }}>
        <Text
          sx={{
            display: 'block',
            mb: [2]
          }}>
          Share
        </Text>
        <Text
          sx={{
            display: 'block',
            mb: [2]
          }}>
          <a target="blank" href={Url.urlPrefix + params.conversation_id}>
            {Url.urlPrefix + params.conversation_id}
          </a>
        </Text>
      </Box>
      <Box sx={{ mb: [5] }}>
        <Text
          sx={{
            display: 'block',
            mb: [2]
          }}>
          Embed
        </Text>
        <div>
          <pre>
            {'<div'}
            {" class='polis'"}
            {" data-conversation_id='" + params.conversation_id + "'>"}
            {'</div>\n'}
            {"<script async src='" + Url.urlPrefix + "embed.js'></script>"}
          </pre>
        </div>
        <Text
          sx={{
            display: 'block',
            maxWidth: '35em',
            mt: [2]
          }}>
          This embed code can only be used to embed a single conversation.{' '}
          <Link to="/integrate">I want to integrate pol.is on my entire site.</Link>
        </Text>
        <div>{zid_metadata.zid_metadata.parent_url ? constructEmbeddedOnMarkup() : ''}</div>
      </Box>

      <ParticipantXids conversation_id={params.conversation_id} />
    </div>
  )
}

export default ShareAndEmbed
