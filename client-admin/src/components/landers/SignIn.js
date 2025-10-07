// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import PropTypes from 'prop-types'
import { Navigate } from 'react-router'
import { Heading, Box, Button } from 'theme-ui'
import StaticLayout from './lander-layout'

import { useAuth } from 'react-oidc-context'

const SignIn = ({ authed }) => {
  const auth = useAuth()

  const drawLoginForm = () => {
    return (
      <Box>
        <Button
          sx={{ my: [2] }}
          id="signinButton"
          onClick={() =>
            auth.signinRedirect({
              state: { returnTo: window.location.pathname }
            })
          }>
          Sign In
        </Button>
      </Box>
    )
  }

  if (authed) {
    return <Navigate to={'/'} />
  }

  return (
    <StaticLayout>
      <Box>
        <Heading as="h1" sx={{ my: [4, null, 5], fontSize: [6, null, 7] }}>
          Sign In
        </Heading>
        {drawLoginForm()}
      </Box>
    </StaticLayout>
  )
}

SignIn.propTypes = {
  authed: PropTypes.bool
}

export default SignIn
