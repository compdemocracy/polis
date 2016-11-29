// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import Radium from "radium";
import Flex from "../framework/flex";
import Button from "../framework/generic-button";
import ParticipantHeader from "./participant-header";

@Radium
class Comment extends React.Component {
  static propTypes = {
    dispatch: React.PropTypes.func,
    params: React.PropTypes.object,
    acceptButton: React.PropTypes.bool,
    rejectButton: React.PropTypes.bool,
    acceptClickHandler: React.PropTypes.func,
    rejectClickHandler: React.PropTypes.func,
  }
  getStyles() {
    return {
      card: {
        margin: "10px 20px 10px 20px",
        backgroundColor: "rgb(253,253,253)",
        borderRadius: 3,
        padding: 10,
        WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
        BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)"
      },
      commentBody: {
        maxWidth: 550,
        fontWeight: 300,
        marginLeft: 10
      },
      info: {
        fontWeight: 300,
        fontSize: 14,
        marginTop: 0,
        marginLeft: 10,
      }
    }
  }
  onAcceptClicked() {
    this.props.acceptClickHandler(this.props.comment)
  }
  onRejectClicked() {
    this.props.rejectClickHandler(this.props.comment)
  }
  makeAcceptButton() {
    return (
      <Button
        style={{
          backgroundColor: "#03a9f4",
          color: "white",
        }}
        onClick={this.onAcceptClicked.bind(this)}>
        accept
      </Button>
    )
  }
  makeRejectButton() {
    return (
      <Button
        style={{
          backgroundColor: "#03a9f4",
          color: "white",
        }}
        onClick={this.onRejectClicked.bind(this)}>
        reject
      </Button>
    )
  }
  getDate() {
    const date = new Date(+this.props.comment.created);
    return `${date.getMonth()+1} / ${date.getUTCDate()} / ${date.getFullYear()}`
  }
  render() {
    const styles = this.getStyles();
    const showAsAnon = !this.props.comment.social || this.props.comment.anon || this.props.comment.is_seed;
    return (
      <div style={styles.card}>
        <Flex
          direction="column"
          wrap="wrap"
          justifyContent="space-between"
          alignItems={"baseline"}>
          {
            showAsAnon ?
              "Anonymous" :
              <ParticipantHeader {...this.props.comment.social} />
          }
          <Flex grow={1}>
            <p style={styles.commentBody}>{ this.props.comment.txt }</p>
          </Flex>
          <p style={styles.info}>
            Created on
            <span style={{fontWeight: 500}}> {this.getDate()}</span>,
            voted on a total of
            <span style={{fontWeight: 500}}> {this.props.comment.count} </span>
            times.
          </p>
          <Flex>
            { this.props.acceptButton ? this.makeAcceptButton() : "" }
            { this.props.rejectButton ? this.makeRejectButton() : "" }
          </Flex>
        </Flex>
      </div>
    );
  }
}

export default Comment;

/*
  todo
    show stats per comment
    sort by number of votes time submitted etc
*/
