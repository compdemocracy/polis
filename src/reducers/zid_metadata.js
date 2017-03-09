// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import * as types from "../actions";

const zid = (state = {
  loading: false,
  zid_metadata: {},
  error: null,
  optimistic: 0 /* `h4x0rz` trigger render because shallow comparison https://github.com/reactjs/redux/issues/585 */
}, action) => {
  switch (action.type) {
  case types.REQUEST_ZID_METADATA:
    return Object.assign({}, state, {
      conversation_id: action.data.conversation_id,
      loading: true,
      error: null
    });
  case types.RECEIVE_ZID_METADATA:
    return Object.assign({}, state, {
      loading: false,
      zid_metadata: action.data,
      error: null
    });
  case types.ZID_METADATA_RESET:
    return Object.assign({}, state, {
      loading: false,
      zid_metadata: {},
      error: null
    });
  case types.OPTIMISTIC_ZID_METADATA_UPDATE:
    return Object.assign({}, state, {
      loading: false,
      zid_metadata: action.data,
      error: null,
      optimistic: Math.random()
    })
  case types.UPDATE_ZID_METADATA_STARTED:
    return Object.assign({}, state, {
      loading: true,
      error: null
    });
  case types.UPDATE_ZID_METADATA_SUCCESS:
    return Object.assign({}, state, {
      loading: false,
      zid_metadata: action.data,
      error: null
    });
  case types.UPDATE_ZID_METADATA_ERROR:
    return Object.assign({}, state, {
      loading: false,
      error: action.data
    });
  default:
    return state;
  }
};

export default zid;
