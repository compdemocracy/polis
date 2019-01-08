// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

module.exports = {
  VIS_TYPE: {
    OFF: 0,
    PCA: 1,
    TOP_COMMENTS: 2,
  },
  CHARACTER_LIMIT: 280, // we can import tweets, so 280
  commentCarouselMinHeight: 275, // based on CHARACTER_LIMIT and font size
  REACTIONS: {
    AGREE: -1,
    PASS: 0,
    DISAGREE: 1
  },
  MOD: {
    BAN: -1,
    UNMODERATED: 0,
    OK: 1
  }
};
