// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.
/** @jsx jsx */

import React from 'react'
import { connect } from 'react-redux'
import { doSignin } from '../../actions'
import { Link, Redirect } from 'react-router-dom'
import { Heading, Box, Text, Button, jsx } from 'theme-ui'
import StaticLayout from './lander-layout'

import strings from '../../strings/strings'

@connect((state) => state.signin)
class SignIn extends React.Component {
  static getDerivedStateFromError(error) {
    // Update state so the next render will show the fallback UI.
    return { hasError: true }
  }

  componentDidMount() {
    this.props.dispatch({ type: 'signin reset state' })
  }

  componentDidCatch(error, errorInfo) {
    // You can also log the error to an error reporting service
    console.log(error, errorInfo)
  }

  // getDest() {
  //   return this.props.location.pathname.slice("/signin".length);
  // }

  handleLoginClicked(e) {
    e.preventDefault()
    const attrs = {
      email: this.email.value,
      password: this.password.value
    }

    // var dest = this.getDest();
    // if (!dest.length) {
    //   dest = "/";
    // }
    this.props.dispatch(doSignin(attrs))
  }

  maybeErrorMessage() {
    let markup = ''
    if (this.props.error) {
      markup = <div>{strings(this.props.error.responseText)}</div>
    }
    return markup
  }

  drawLoginForm() {
    return (
      <Box>
        <form>
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
              id="signinEmailInput"
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
              id="signinPasswordInput"
              ref={(c) => (this.password = c)}
              placeholder="password"
              type="password"
            />
          </Box>
          {this.maybeErrorMessage()}
          <Button
            sx={{ my: [2] }}
            id="signinButton"
            onClick={this.handleLoginClicked.bind(this)}>
            {this.props.pending ? 'Signing in...' : 'Sign In'}
          </Button>
          <Text sx={{ my: 4 }}>
            {'Forgot your password? '}
            <Link to={'/pwresetinit'}>Reset Password</Link>
          </Text>
          <Text sx={{ my: 4 }}>
            {'Or '}
            <Link to={'/createuser'}>Create an Account</Link>
          </Text>
        </form>
      </Box>
    )
  }

  render() {
    const { signInSuccessful, authed } = this.props

    if (signInSuccessful || authed) {
      return <Redirect to={'/'} />
    }

    return (
      <StaticLayout>
        <Heading as="h1" sx={{ my: [4, null, 5], fontSize: [6, null, 7] }}>
          Sign In
        </Heading>
        {this.drawLoginForm()}
      </StaticLayout>
    )
  }
}

export default SignIn
