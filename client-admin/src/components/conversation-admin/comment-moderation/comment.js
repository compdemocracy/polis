// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import _ from "lodash";
import React from "react";
import { connect } from "react-redux";

@connect((state) => {
  return {
    conversation: state.zid_metadata.zid_metadata,
  };
})
class Comment extends React.Component {
  onAcceptClicked() {
    this.props.acceptClickHandler(this.props.comment);
  }
  onRejectClicked() {
    this.props.rejectClickHandler(this.props.comment);
  }
  onIsMetaClicked() {
    this.props.toggleIsMetaHandler(this.props.comment, this.refs.is_meta.isChecked());
  }
  makeAcceptButton() {
    return <button onClick={this.onAcceptClicked.bind(this)}>{this.props.acceptButtonText}</button>;
  }
  makeRejectButton() {
    return <button onClick={this.onRejectClicked.bind(this)}>{this.props.rejectButtonText}</button>;
  }

  render() {
    return (
      <div>
        <div>
          <p>{this.props.comment.txt}</p>
          <div>
            {this.props.isMetaCheckbox ? "metadata" : null}
            {this.props.isMetaCheckbox ? (
              <input
                type="checkbox"
                label="metadata"
                ref="is_meta"
                checked={this.props.comment.is_meta}
                onCheck={this.onIsMetaClicked.bind(this)}
              />
            ) : (
              ""
            )}
            {this.props.acceptButton ? this.makeAcceptButton() : ""}
            {this.props.rejectButton ? this.makeRejectButton() : ""}
          </div>
        </div>
      </div>
    );
  }
}

export default Comment;
