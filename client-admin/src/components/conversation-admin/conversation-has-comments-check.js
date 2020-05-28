// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import _ from "lodash";
import Flex from "../framework/flex";
import Radium from "radium";
import React from "react";
import Spinner from "../framework/spinner";
import strings from "../../strings/strings";
import { connect } from "react-redux";
import { populateAllCommentStores, changeCommentStatusToRejected } from "../../actions";

@connect((state) => state.mod_comments_accepted)
@connect((state) => state.mod_comments_rejected)
@connect((state) => state.mod_comments_unmoderated)
@Radium
class ConversationHasCommentsCheck extends React.Component {
  componentWillMount() {
    this.props.dispatch(populateAllCommentStores(this.props.conversation_id));
  }
  createCommentMarkup() {
    const numAccepted = this.props.accepted_comments.length;
    const numRejected = this.props.rejected_comments.length;
    const numUnmoderated = this.props.unmoderated_comments.length;

    const isStrictMod = this.props.strict_moderation;
    const numVisible = numAccepted + (isStrictMod ? 0 : numUnmoderated);

    let s = "";
    if (numVisible === 0) {
      if (isStrictMod && numUnmoderated > 0) {
        s = strings("share_but_no_visible_comments_warning");
      } else {
        s = strings("share_but_no_comments_warning");
      }
      return (
        <Flex styleOverrides={this.getStyles().card} alignItems="center">
          {s}
        </Flex>
      );
    } else {
      return null;
    }
  }
  renderSpinner() {
    return (
      <Flex>
        <Spinner />
        <span
          style={{
            marginLeft: 10,
            position: "relative",
            top: -2,
          }}
        >
          {" "}
          Loading accepted comments...{" "}
        </span>
      </Flex>
    );
  }
  getStyles() {
    return {
      card: {
        margin: "10px 20px 10px 20px",
        backgroundColor: "rgb(253,253,253)",
        borderRadius: 3,
        padding: "0px 20px",
        WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
        BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
      },
    };
  }
  render() {
    return (
      <div>
        {this.props.accepted_comments !== null && this.props.rejected_comments !== null
          ? this.createCommentMarkup()
          : this.renderSpinner()}
      </div>
    );
  }
}

export default ConversationHasCommentsCheck;
