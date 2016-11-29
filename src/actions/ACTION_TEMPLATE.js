// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

export const REQUEST_BAZ = "REQUEST_BAZ";
export const RECEIVE_BAZ = "RECEIVE_BAZ";
export const BAZ_FETCH_ERROR = "BAZ_FETCH_ERROR";

/* request foo */

const requestFoo = () => {
  return {
    type: REQUEST_BAZ
  }
};

const receiveFoo = (data) => {
  return {
    type: RECEIVE_BAZ,
    data: data
  }
};

const barFetchError = (err) => {
  return {
    type: BAZ_FETCH_ERROR,
    data: err
  }
}

const fetchFoo = (conversation_id) => {
  return $.get("/api/v3/QUX?conversation_id=" + conversation_id);
};

export const populateFooStore = (conversation_id) => {
  return (dispatch) => {
    dispatch(requestFoo());
    return fetchFoo(conversation_id).then(
      (res) => dispatch(receiveFoo(res)),
      (err) => dispatch(barFetchError(err))
    );
  };
};
