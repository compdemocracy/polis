// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

module.exports = {
  CHARACTER_LIMIT: 140, // we can import tweets, so 140
  commentCarouselMinHeight: 135, // based on CHARACTER_LIMIT and font size
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
