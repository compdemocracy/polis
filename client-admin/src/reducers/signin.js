// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import * as types from "../actions";

const signin = (state = {
  loading: false,
  facebookLoading: false,
  error: false,
  facebookError: false
}, action) => {
  switch (action.type) {
  case types.FACEBOOK_SIGNIN_INITIATED:
    return Object.assign({}, state, {
      loading: false,
      facebookLoading: true,
      error: false,
      facebookError: false
    });
  case types.FACEBOOK_SIGNIN_SUCCESSFUL:
    return Object.assign({}, state, {
      loading: false,
      facebookLoading: false,
      error: false,
      facebookError: false
    });
  case types.FACEBOOK_SIGNIN_FAILED:
    return Object.assign({}, state, {
      loading: false,
      facebookLoading: false,
      error: false,
      facebookError: action.errorCode
    });
  case types.SIGNIN_INITIATED:
    return Object.assign({}, state, {
      loading: false,
      pending: true,
      facebookLoading: false,
      error: false,
    });
  case types.SIGNIN_ERROR:
    return Object.assign({}, state, {
      loading: false,
      pending: false,
      facebookLoading: false,
      error: action.data,
    });
  case types.CREATEUSER_INITIATED:
    return Object.assign({}, state, {
      loading: false,
      pending: true,
      facebookLoading: false,
      error: false,
    });
  case types.CREATEUSER_ERROR:
    return Object.assign({}, state, {
      loading: false,
      pending: false,
      facebookLoading: false,
      error: action.data,
    });







  default:
    return state;
  }
};

export default signin;







