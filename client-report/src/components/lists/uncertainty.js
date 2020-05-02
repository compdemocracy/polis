// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import _ from "lodash";
import CommentList from "./commentList";
import * as globals from "../globals";
import style from "../../util/style";

const Uncertainty = ({conversation, comments, ptptCount, uncertainty, formatTid, math, voteColors}) => {

  if (!conversation) {
    return <div>Loading Uncertainty...</div>
  }
  return (
    <div>
      <p style={globals.primaryHeading}> Areas of uncertainty </p>
      <p style={globals.paragraph}>
        Across all {ptptCount} participants, there was uncertainty about the following statements.
        Greater than 30% of participants who saw these statements 'passed'.
      </p>
      <p style={globals.paragraph}>
        Areas of uncertainty can provide avenues to educate and open dialogue with your community.
      </p>
      <div style={{marginTop: 50}}>
        <CommentList
          conversation={conversation}
          ptptCount={ptptCount}
          math={math}
          formatTid={formatTid}
          tidsToRender={uncertainty /* uncertainTids would be funnier */}
          comments={comments}
          voteColors={voteColors}/>
      </div>
    </div>
  );
};

export default Uncertainty;
