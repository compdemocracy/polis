// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import * as types from '../actions'

const zid = (
  state = {
    loading: false,
    error: null,
    optimistic: 0 /* `h4x0rz` trigger render because shallow comparison https://github.com/reactjs/redux/issues/585 */
  },
  action
) => {
  switch (action.type) {
    case types.REQUEST_CONVERSATION_DATA:
      return {
        ...state,
        conversation_id: action.data.conversation_id,
        loading: true,
        error: null
      }
    case types.RECEIVE_CONVERSATION_DATA:
      return {
        ...state,
        loading: false,
        ...action.data,
        error: null
      }
    case types.CONVERSATION_DATA_RESET:
      return {
        loading: false,
        error: null,
        optimistic: 0
      }
    case types.OPTIMISTIC_CONVERSATION_DATA_UPDATE:
      return {
        ...state,
        loading: false,
        ...action.data,
        error: null,
        optimistic: Math.random()
      }
    case types.UPDATE_CONVERSATION_DATA_STARTED:
      return {
        ...state,
        loading: true,
        error: null
      }
    case types.UPDATE_CONVERSATION_DATA_SUCCESS:
      return {
        ...state,
        loading: false,
        ...action.data,
        error: null
      }
    case types.UPDATE_CONVERSATION_DATA_ERROR:
      return {
        ...state,
        loading: false,
        error: action.data
      }
    default:
      return state
  }
}

export default zid
