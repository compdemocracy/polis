// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import { connect } from "react-redux";
import { populateAcceptedCommentsStore, changeCommentStatusToRejected } from '../../actions';
import Radium from "radium";
import _ from "lodash";
import Comment from "./comment";
import Spinner from "../framework/spinner";
import Flex from "../framework/flex";


// @connect(state => state.mod_comments_accepted)
@Radium
class ReportCommentsIncluded extends React.Component {
  onCommentRejected(comment) {
    this.props.commentWasExcluded(comment);
  }
  createCommentMarkup() {
    if (!this.props.includedComments) {
      return "";
    }
    const comments = this.props.includedComments.map((comment, i) => {
      return (
        <Comment
          key={i}
          rejectButton
          rejectClickHandler={this.onCommentRejected.bind(this)}
          rejectButtonText="exclude"
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
          }}> Loading comments to be included in correlation matrix... </span>
      </Flex>
    )
  }
  render() {
    return (
      <div>
      <div>These comments will be included in the correlation matrix of this report.</div>
      <div>If the matrix is too big, try excluding comments here. Excluded comments will still appear elsewhere in the report.</div>
        <div>
          {
            this.props.includedComments !== null ?
              this.createCommentMarkup() :
              this.renderSpinner()
          }
        </div>
      </div>
    );
  }
}

export default ReportCommentsIncluded;
