// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

/** @jsx jsx */

import React from 'react'
import { connect } from 'react-redux'
import {
  handleSeedCommentSubmit,
  seedCommentChanged,
  handleBulkSeedCommentSubmit
} from '../../actions'
import strings from '../../strings/strings'
import { Box, Text, Button, jsx, Link, Heading } from 'theme-ui'

@connect((state) => state.seed_comments)
class ModerateCommentsSeed extends React.Component {
  constructor(props) {
    super(props)
    this.state = {
      showErrorDialogue: false,
      showSuccessDialogue: false,
      csv: undefined
    }
  }

  handleSubmitSeed() {
    const comment = {
      txt: this.seed_form.value,
      pid: -1,
      conversation_id: this.props.params.conversation_id,
      // vote: 0,
      is_seed: true
    }
    this.props.dispatch(handleSeedCommentSubmit(comment))
  }

  handleSubmitSeedBulk() {
    this.props.dispatch(
      handleBulkSeedCommentSubmit({
        csv: this.state.csvText,
        pid: 'mypid',
        conversation_id: this.props.params.conversation_id,
        // vote: 0,
        is_seed: true
      })
    )
  }

  handleFileChange(e) {
    const file = e.target.files[0]
    if (!file) {
      return
    }

    const reader = new FileReader()
    reader.onload = (event) => {
      const text = event.target.result
      this.setState({ csvText: text })
    }
    reader.readAsText(file)
  }

  handleTextareaChange(e) {
    this.props.dispatch(seedCommentChanged(e.target.value))
  }

  getButtonText() {
    let text = 'Submit'

    if (this.props.success) {
      text = 'Success!'
    }

    if (this.props.loading) {
      text = 'Saving...'
    }

    return text
  }

  render() {
    const { seedText } = this.props
    return (
      <Box sx={{ mb: [4] }}>
        <Text sx={{ mb: [2] }}>
          Add{' '}
          <Link target='_blank' href='https://compdemocracy.org/seed-comments'>
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
            onChange={this.handleTextareaChange.bind(this)}
            maxLength='400'
            data-testid='seed_form'
            value={seedText}
            ref={(c) => (this.seed_form = c)}
          />
        </Box>
        <Box>
          <Button onClick={this.handleSubmitSeed.bind(this)}>
            {this.getButtonText()}
          </Button>
          {this.props.error ? <Text>{strings(this.props.error)}</Text> : null}
        </Box>
        <Box sx={{ mt: 2, display: 'block' }}>
          <Heading
            as='h6'
            sx={{
              fontSize: [1, null, 2],
              lineHeight: 'body',
              my: [3, null, 4]
            }}
          >
            Upload a CSV of seed comments
          </Heading>
          <input
            onChange={this.handleFileChange.bind(this)}
            type='file'
            id='csvFile'
            accept='.csv'
          ></input>
          <Button onClick={this.handleSubmitSeedBulk.bind(this)}>
            {this.getButtonText()}
          </Button>
        </Box>
      </Box>
    )
  }
}

export default ModerateCommentsSeed

// value={this.props.seedText}
