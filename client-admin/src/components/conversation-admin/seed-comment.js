// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { useState, useRef } from 'react'
import PropTypes from 'prop-types'
import { useSelector, useDispatch } from 'react-redux'
import {
  handleSeedCommentSubmit,
  seedCommentChanged,
  handleBulkSeedCommentSubmit
} from '../../actions'
import strings from '../../strings/strings'
import { Box, Text, Button, Link, Heading } from 'theme-ui'

const ModerateCommentsSeed = ({ params }) => {
  const dispatch = useDispatch()
  const { seedText, loading, success, error } = useSelector((state) => state.seed_comments)

  const [csvText, setCsvText] = useState(undefined)
  const seedFormRef = useRef(null)

  const handleSubmitSeed = () => {
    const comment = {
      txt: seedFormRef.current.value,
      pid: -1,
      conversation_id: params.conversation_id,
      // vote: 0,
      is_seed: true
    }
    dispatch(handleSeedCommentSubmit(comment))
  }

  const handleSubmitSeedBulk = () => {
    dispatch(
      handleBulkSeedCommentSubmit({
        csv: csvText,
        pid: 'mypid',
        conversation_id: params.conversation_id,
        // vote: 0,
        is_seed: true
      })
    )
  }

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

  const handleTextareaChange = (e) => {
    dispatch(seedCommentChanged(e.target.value))
  }

  const getButtonText = () => {
    let text = 'Submit'

    if (success) {
      text = 'Success!'
    }

    if (loading) {
      text = 'Saving...'
    }

    return text
  }

  return (
    <Box sx={{ mb: [4] }}>
      <Text sx={{ mb: [2] }}>
        Add{' '}
        <Link target="_blank" href="https://compdemocracy.org/seed-comments">
          seed comments or bulk upload as csv
        </Link>{' '}
        for participants to vote on:
      </Text>
      <Box sx={{ mb: [2] }}>
        <textarea
          sx={{
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
          onChange={handleTextareaChange}
          maxLength="400"
          data-testid="seed_form"
          value={seedText}
          ref={seedFormRef}
        />
      </Box>
      <Box>
        <Button onClick={handleSubmitSeed}>{getButtonText()}</Button>
        {error ? <Text>{strings(error)}</Text> : null}
      </Box>
      <Box sx={{ mt: 2, display: 'block' }}>
        <Heading
          as="h6"
          sx={{
            fontSize: [1, null, 2],
            lineHeight: 'body',
            my: [3, null, 4]
          }}>
          Upload a CSV of seed comments
        </Heading>
        <input onChange={handleFileChange} type="file" id="csvFile" accept=".csv"></input>
        <Button onClick={handleSubmitSeedBulk}>{getButtonText()}</Button>
      </Box>
    </Box>
  )
}

ModerateCommentsSeed.propTypes = {
  params: PropTypes.shape({
    conversation_id: PropTypes.string.isRequired
  }).isRequired
}

export default ModerateCommentsSeed

// value={this.props.seedText}
