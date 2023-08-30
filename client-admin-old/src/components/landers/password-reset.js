// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from 'react'
import PropTypes from 'prop-types'
import { connect } from 'react-redux'
import { doPasswordReset } from '../../actions'
import StaticLayout from './lander-layout'

@connect()
class PasswordReset extends React.Component {
  handleClick(e) {
    e.preventDefault()
    const attrs = {
      newPassword: this.password.value,
      pwresettoken: this.props.location.pathname.slice('/pwreset/'.length)
    }

    if (attrs.newPassword !== this.passwordRepeat.value) {
      alert('Passwords need to match')
      return
    }

    this.props.dispatch(doPasswordReset(attrs))
  }

  render() {
    return (
      <StaticLayout>
        <h1>Password Reset</h1>
        <form>
          <input
            ref={(c) => (this.password = c)}
            placeholder="new password"
            type="password"
          />
          <input
            ref={(c) => (this.passwordRepeat = c)}
            placeholder="repeat new password"
            type="password"
          />
          <button onClick={this.handleClick.bind(this)}>
            Set new password
          </button>
        </form>
      </StaticLayout>
    )
  }
}

PasswordReset.propTypes = {
  dispatch: PropTypes.func,
  location: PropTypes.object
}

export default PasswordReset
