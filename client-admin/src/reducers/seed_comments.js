// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import * as types from '../actions'

const seed_comments = (
  state = {
    seedText: '',
    loading: false,
    error: false,
    success: false
  },
  action
) => {
  switch (action.type) {
    case types.SEED_COMMENT_LOCAL_UPDATE:
      return Object.assign({}, state, {
        loading: false,
        error: false,
        seedText: action.text,
        success: false
      })
    case types.SUBMIT_SEED_COMMENT:
      return Object.assign({}, state, {
        loading: true,
        error: false,
        success: false
      })
    case types.SUBMIT_SEED_COMMENT_SUCCESS:
      return Object.assign({}, state, {
        loading: false,
        seedText: '',
        error: false,
        success: true
      })
    case types.SUBMIT_SEED_COMMENT_ERROR:
      return Object.assign({}, state, {
        loading: false,
        error: action.data.responseText,
        success: false
      })
    default:
      return state
  }
}

export default seed_comments
