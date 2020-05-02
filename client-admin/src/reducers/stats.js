// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import * as types from "../actions";

const conversation_stats = (state = {
  loading: false,
  conversation_stats: {},
}, action) => {
  switch (action.type) {
  case types.REQUEST_CONVERSATION_STATS:
    return Object.assign({}, state, {
      loading: true
    });
  case types.RECEIVE_CONVERSATION_STATS:
    return Object.assign({}, state, {
      loading: false,
      conversation_stats: action.data
    });
  default:
    return state;
  }
};

export default conversation_stats;
