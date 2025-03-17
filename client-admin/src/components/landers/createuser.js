// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.
/** @jsx jsx */

import React from 'react'
import { connect } from 'react-redux'
import { doCreateUser } from '../../actions'
import { Heading, Box, Button, jsx } from 'theme-ui'

import { Link } from 'react-router-dom'
import StaticLayout from './lander-layout'
import strings from '../../strings/strings'

@connect((state) => state.signin)
class Createuser extends React.Component {
  getDest() {
    return this.props.location.pathname.slice('/createuser'.length)
  }

  handleLoginClicked(e) {
    e.preventDefault()
    const attrs = {
      hname: this.hname.value,
      email: this.email.value,
      password: this.password.value,
      gatekeeperTosPrivacy: true
    }

    let dest = this.getDest()
    if (!dest.length) {
      dest = '/'
    }
    this.props.dispatch(doCreateUser(attrs, dest))
  }

  maybeErrorMessage() {
    let markup = ''
    if (this.props.error) {
      markup = <div>{strings(this.props.error.responseText)}</div>
    }
    return markup
  }

  drawForm() {
    return (
      <Box>
        <form sx={{ mb: [4] }}>
          <Box sx={{ my: [2] }}>
            <input
              sx={{
                fontFamily: 'body',
                fontSize: [2],
                width: '35em',
                borderRadius: 2,
                padding: [2],
                border: '1px solid',
                borderColor: 'mediumGray'
              }}
              id="createUserNameInput"
              ref={(c) => (this.hname = c)}
              placeholder="name"
              type="text"
            />
          </Box>
          <Box sx={{ my: [2] }}>
            <input
              sx={{
                fontFamily: 'body',
                fontSize: [2],
                width: '35em',
                borderRadius: 2,
                padding: [2],
                border: '1px solid',
                borderColor: 'mediumGray'
              }}
              id="createUserEmailInput"
              ref={(c) => (this.email = c)}
              placeholder="email"
              type="email"
            />
          </Box>
          <Box sx={{ my: [2] }}>
            <input
              sx={{
                fontFamily: 'body',
                fontSize: [2],
                width: '35em',
                borderRadius: 2,
                padding: [2],
                border: '1px solid',
                borderColor: 'mediumGray'
              }}
              id="createUserPasswordInput"
              ref={(c) => (this.password = c)}
              placeholder="password"
              type="password"
            />
          </Box>
          <Box sx={{ my: [2] }}>
            <input
              sx={{
                fontFamily: 'body',
                fontSize: [2],
                width: '35em',
                borderRadius: 2,
                padding: [2],
                border: '1px solid',
                borderColor: 'mediumGray'
              }}
              id="createUserPasswordRepeatInput"
              ref={(c) => (this.password2 = c)}
              placeholder="repeat password"
              type="password"
            />
          </Box>
          {this.maybeErrorMessage()}

          <Box>
            I agree to the{' '}
            <a href="https://pol.is/tos" tabIndex="110">
              pol.is terms
            </a>{' '}
            and{' '}
            <a href="https://pol.is/privacy" tabIndex="111">
              {' '}
              privacy agreement
            </a>
            .
          </Box>
          <Button
            sx={{ my: [2] }}
            id="createUserButton"
            onClick={this.handleLoginClicked.bind(this)}>
            {this.props.pending ? 'Creating Account...' : 'Create Account'}
          </Button>
        </form>
        <Box sx={{ mb: [4] }}>
          Already have an account?{' '}
          <Link
            tabIndex="6"
            to={'/signin' + this.getDest()}
            data-section="signup-select">
            Sign in
          </Link>
        </Box>
      </Box>
    )
  }

  render() {
    return (
      <StaticLayout>
        <div>
          <Heading as="h1" sx={{ my: [4, null, 5], fontSize: [6, null, 7] }}>
            Create Account
          </Heading>
          {this.drawForm()}
        </div>
      </StaticLayout>
    )
  }
}

export default Createuser
