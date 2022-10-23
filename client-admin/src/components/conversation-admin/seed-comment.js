// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

/** @jsx jsx */

import React from 'react'
import { connect } from 'react-redux'
import { handleSeedCommentSubmit, seedCommentChanged } from '../../actions'
import strings from '../../strings/strings'
import { Box, Text, Button, jsx, Link } from 'theme-ui'

@connect((state) => state.seed_comments)
class ModerateCommentsSeed extends React.Component {
  constructor(props) {
    super(props)
    this.state = {
      showErrorDialogue: false,
      showSuccessDialogue: false
    }
  }

  handleSubmitSeed() {
    const comment = {
      txt: this.seed_form.value,
      pid: 'mypid',
      conversation_id: this.props.params.conversation_id,
      // vote: 0,
      is_seed: true
    }
    this.props.dispatch(handleSeedCommentSubmit(comment))
  }

  handleCsvSeed() {
    document.getElementById('file-upload').click()
  }

  handleFileUpload(e) {
    console.log(e.target.files[0])
    let file = e.target.files[0]
    if (file) {
      if (file.type !== 'text/csv') {
        alert('File must be in csv format')
        return
      }
      let fr = new FileReader()
      fr.onload = (e) => {
        let commentTexts = fr.result.split(/\r?\n/);
        console.log(commentTexts);
        commentTexts.forEach(commentText => {
          const comment = {
            txt: commentText,
            pid: 'mypid',
            conversation_id: this.props.params.conversation_id,
            // vote: 0,
            is_seed: true
          }
          this.props.dispatch(handleSeedCommentSubmit(comment))
          // TODO: why does it always fail for one random row?
        });
      }
      fr.readAsText(file);
    }
  }

  handleTextareaChange(e) {
    this.props.dispatch(seedCommentChanged(e.target.value))
  }

  render() {
    const { seedText } = this.props
    return (
      <Box sx={{ mb: [4] }}>
        <Text sx={{ mb: [2] }}>
          Add{' '}
          <Link target="_blank" href="https://compdemocracy.org/seed-comments">
            seed comments
          </Link>{' '}
          for participants to vote on. For CSV uploads, please ensure that each 
          comment is in its own row and does not contain any newline characters. 
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
            maxLength="400"
            data-test-id="seed_form"
            value={seedText}
            ref={(c) => (this.seed_form = c)}
          />
        </Box>
        <Box>
          <Button onClick={this.handleSubmitSeed.bind(this)} sx={{ mb: [2] }}>
            Submit
          </Button>
          <Button onClick={this.handleCsvSeed} sx={{ ml: [2] }}>
            Upload from CSV
          </Button>
          <input id="file-upload" type="file" onChange={this.handleFileUpload.bind(this)} sx={{ display: 'none' }}/>
          {
            this.props.error ? 
            <Text>{strings(this.props.error)}</Text> : 
            this.props.loading ? 
            <Text>Saving...</Text> : 
            this.props.success ? 
            <Text>Success!</Text> : 
            null
          }
        </Box>
      </Box>
    )
  }
}

export default ModerateCommentsSeed

// value={this.props.seedText}
