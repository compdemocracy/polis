// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from 'react'
import { Box, Text } from 'theme-ui'
import { Link } from 'react-router-dom'

import StaticLayout from './lander-layout'

class PasswordResetInit extends React.Component {
  render() {
    return (
      <StaticLayout>
        <h1>Password Reset</h1>
        <Box sx={{ my: [4] }}>
          <Text>
            Password reset is handled through Auth0. 
            Please <Link to="/signin">sign in</Link> and use the 
            &ldquo;Forgot Password?&rdquo; link on the Auth0 login page.
          </Text>
        </Box>
      </StaticLayout>
    )
  }
}

export default PasswordResetInit
