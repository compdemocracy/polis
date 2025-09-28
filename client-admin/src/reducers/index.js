// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { combineReducers } from 'redux'
import comments from './comments'
import conversations from './conversations'
import mod_comments_accepted from './mod_comments_accepted'
import mod_comments_rejected from './mod_comments_rejected'
import mod_comments_unmoderated from './mod_comments_unmoderated'
import seed_comments from './seed_comments'
import stats from './stats'
import user from './user'
import conversationData from './conversation_data'

const rootReducer = combineReducers({
  comments,
  conversations,
  mod_comments_accepted,
  mod_comments_rejected,
  mod_comments_unmoderated,
  seed_comments,
  stats,
  user,
  conversationData
})

export default rootReducer
