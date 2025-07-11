// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.
/** @jsx jsx */

import React from 'react'
import { Link, Redirect } from 'react-router-dom'
import { Heading, Box, Text, Button, jsx } from 'theme-ui'
import StaticLayout from './lander-layout'

import withAuth0 from '../../util/withAuth0'

class SignIn extends React.Component {
  static getDerivedStateFromError(error) {
    // Update state so the next render will show the fallback UI.
    return { hasError: true }
  }

  componentDidCatch(error, errorInfo) {
    // You can also log the error to an error reporting service
    console.log(error, errorInfo)
  }

  drawLoginForm() {
    return (
      <Box>
        <Button
          sx={{ my: [2] }}
          id="signinButton"
          onClick={this.props.loginWithRedirect}>
          Sign In
        </Button>
        <Text sx={{ my: 4 }}>
          {'Or '}
          <Link to={'/createuser'}>Create an Account</Link>
        </Text>
      </Box>
    )
  }

  render() {
    const { authed } = this.props

    if (authed) {
      return <Redirect to={'/'} />
    }

    return (
      <StaticLayout>
        <Box>
          <Heading as="h1" sx={{ my: [4, null, 5], fontSize: [6, null, 7] }}>
            Sign In
          </Heading>
          {this.drawLoginForm()}
        </Box>
      </StaticLayout>
    )
  }
}

export default withAuth0(SignIn)
