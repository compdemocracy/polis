// // Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import PropTypes from "prop-types";
import Flex from "./flex";
import * as globals from "./globals";
import BarChart from "./barChart";

const Comment = ({ dispatch, params, acceptButton, rejectButton, acceptClickHandler, rejectClickHandler, comment, formatTid, conversation, ptptCount }) => {
  const getDate = () => {
    const date = new Date(+comment.created);
    return `${date.getMonth() + 1} / ${date.getUTCDate()} / ${date.getFullYear()}`;
  };

  const getVoteBreakdown = () => {
    if (typeof comment.agree_count !== "undefined") {
      return (
        <span>
          ({comment.agree_count} agreed, {comment.disagree_count} disagreed, {comment.pass_count} passed)
        </span>
      );
    }
    return "";
  };

  const styles = { ...globals.paragraph, fontStyle: "italic" };

  return (
    <Flex
      styleOverrides={{
        width: "100%",
        marginBottom: 50,
        background: comment.index % 2 !== 0 ? "none" : "none",
      }}
      direction="row"
      justifyContent="flex-start"
      alignItems="flex-start"
    >
      <Flex alignItems="baseline" justifyContent="flex-start" styleOverrides={{ width: globals.paragraphWidth }}>
        <span style={{ ...styles }}>
          {formatTid(comment.tid)} - {comment.is_meta ? "Metadata: " : ""}
          {comment.txt}
        </span>
      </Flex>
      <svg width={globals.barChartWidth} height={70}>
        <line x1="120" y1="0" x2="120" y2="65" strokeWidth="2" stroke="rgb(245,245,245)" />
        <BarChart conversation={conversation} comment={comment} ptptCount={ptptCount} />
      </svg>
    </Flex>
  );
};

Comment.propTypes = {
  dispatch: PropTypes.func,
  params: PropTypes.object,
  acceptButton: PropTypes.bool,
  rejectButton: PropTypes.bool,
  acceptClickHandler: PropTypes.func,
  rejectClickHandler: PropTypes.func,
  comment: PropTypes.object,
  formatTid: PropTypes.func,
  conversation: PropTypes.object,
  ptptCount: PropTypes.number,
};

export default Comment;
