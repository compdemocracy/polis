// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { combineReducers } from "redux";
import conversations from "./conversations";
import user from "./user";
import zid_metadata from "./zid_metadata";
import mod_comments_accepted from "./mod_comments_accepted";
import mod_comments_rejected from "./mod_comments_rejected";
import mod_comments_unmoderated from "./mod_comments_unmoderated";
import mod_ptpt_default from "./mod_ptpt_default";
import mod_ptpt_featured from "./mod_ptpt_featured";
import mod_ptpt_hidden from "./mod_ptpt_hidden";
import stats from "./stats";
import seed_comments from "./seed_comments";
import seed_comments_tweet from "./seed_comments_tweet";
import signout from "./signout";
import signin from "./signin";
import comments from "./comments";
import math from "./math";
import participants from "./participants";


const rootReducer = combineReducers({
  conversations,
  user,
  zid_metadata,
  math,
  comments,
  participants,
  mod_comments_accepted,
  mod_comments_rejected,
  mod_comments_unmoderated,
  mod_ptpt_default,
  mod_ptpt_featured,
  mod_ptpt_hidden,
  seed_comments,
  seed_comments_tweet,
  stats,
  signout,
  signin
});

export default rootReducer;
