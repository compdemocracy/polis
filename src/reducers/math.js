// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import * as types from "../actions";

const Math = (state = {
  loading: false,
  math: null,
  lastVoteTimestamp: -1,
  error: null
}, action) => {
  switch (action.type) {
  case types.REQUEST_MATH:
    return Object.assign({}, state, {
      loading: true,
      error: null
    });
  case types.RECEIVE_MATH:
    return Object.assign({}, state, {
      loading: false,
      error: null,
      math: action.data,
      lastVoteTimestamp: action.data /* this will blow up just haven't checked obj innards yet */
    });
  case types.MATH_FETCH_ERROR:
    return Object.assign({}, state, {
      loading: false,
      error: action.data
    });
  default:
    return state;
  }
};

export default Math;
