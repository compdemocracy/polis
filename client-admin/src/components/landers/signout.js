// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from 'react'
import PropTypes from 'prop-types'

// Auth0 handles logout
import { withAuth0 } from '@auth0/auth0-react'

class SignOut extends React.Component {
  componentDidMount() {
    this.props.auth0.logout({ returnTo: `${window.location.origin}/home` })
  }

  render() {
    return <div>Signing out...</div>
  }
}

SignOut.propTypes = {
  auth0: PropTypes.shape({
    logout: PropTypes.func.isRequired
  }).isRequired
}

export default withAuth0(SignOut)
