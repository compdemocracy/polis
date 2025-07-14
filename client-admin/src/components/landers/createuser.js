// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.
/** @jsx jsx */

import React from 'react'
import { Heading, Box, Button, jsx } from 'theme-ui'

import { Link } from 'react-router-dom'
import StaticLayout from './lander-layout'
import { withAuth0 } from '@auth0/auth0-react'

class Createuser extends React.Component {
  getDest() {
    return this.props.location.pathname.slice('/createuser'.length)
  }

  drawForm() {
    return (
      <Box>
        <Button
          sx={{ my: [2] }}
          id="createUserButton"
          onClick={() => this.props.auth0.loginWithRedirect({
            authorizationParams: {
              screen_hint: 'signup'
            }
          })}>
          Sign Up
        </Button>
        <Box sx={{ my: [4] }}>
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

export default withAuth0(Createuser)
