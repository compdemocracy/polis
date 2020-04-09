// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import { changeCommentStatusToAccepted, changeCommentCommentIsMeta } from '../../actions';
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import Comment from "./comment";
import Spinner from "../framework/spinner";
import Flex from "../framework/flex";


@connect(state => state.mod_comments_rejected)
@Radium
class ModerateCommentsRejected extends React.Component {

  onCommentAccepted(comment) {
    this.props.dispatch(changeCommentStatusToAccepted(comment))
  }

  toggleIsMetaHandler(comment, is_meta) {
    this.props.dispatch(changeCommentCommentIsMeta(comment, is_meta));
  }

  createCommentMarkup() {
    const comments = this.props.rejected_comments.map((comment, i)=>{
      return (
        <Comment
          key={i}
          acceptButton
          acceptButtonText="accept"
          acceptClickHandler={this.onCommentAccepted.bind(this)}
          isMetaCheckbox
          toggleIsMetaHandler={this.toggleIsMetaHandler.bind(this)}
          comment={comment}/>
      )
    })
    return comments;
  }

  renderSpinner() {
    return (
      <Flex>
        <Spinner/>
        <span style={{
            marginLeft: 10,
            position: "relative",
            top: -2
          }}> Loading rejected comments... </span>
      </Flex>
    )
  }

  render() {
    return (
      <div>
        <div>
          {
            this.props.rejected_comments !== null ?
              this.createCommentMarkup() :
              this.renderSpinner()
          }
        </div>
      </div>
    );
  }
}

export default ModerateCommentsRejected;
