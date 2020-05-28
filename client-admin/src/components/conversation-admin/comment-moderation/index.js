// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.
/** @jsx jsx */

import _ from "lodash";
import ComponentHelpers from "../../../util/component-helpers";

import NoPermission from "../no-permission";
import React from "react";
import { connect } from "react-redux";
import { populateAllCommentStores } from "../../../actions";
import { Heading, Flex, Box, jsx } from "theme-ui";

import ModerateCommentsTodo from "./moderate-comments-todo";
import ModerateCommentsAccepted from "./moderate-comments-accepted";
import ModerateCommentsRejected from "./moderate-comments-rejected";

import { Switch, Route, Link, Redirect } from "react-router-dom";

const mapStateToProps = (state, ownProps) => {
  return {
    unmoderated: state.mod_comments_unmoderated,
    accepted: state.mod_comments_accepted,
    rejected: state.mod_comments_rejected,
    seed: state.seed_comments,
  };
};

const pollFrequency = 60000;

@connect((state) => state.zid_metadata)
@connect(mapStateToProps)
class CommentModeration extends React.Component {
  getStyles() {
    return {
      navContainer: {
        margin: "10px 20px 20px 20px",
      },
    };
  }
  loadComments() {
    const { match } = this.props;
    this.props.dispatch(populateAllCommentStores(match.params.conversation_id));
  }
  componentWillMount() {
    this.getCommentsRepeatedly = setInterval(() => {
      this.loadComments();
    }, pollFrequency);
  }
  componentDidMount() {
    this.loadComments();
  }
  componentWillUnmount() {
    clearInterval(this.getCommentsRepeatedly);
  }
  render() {
    if (ComponentHelpers.shouldShowPermissionsError(this.props)) {
      return <NoPermission />;
    }
    const { match } = this.props;

    return (
      <Box>
        <Heading
          as="h3"
          sx={{
            fontSize: [3, null, 4],
            lineHeight: "body",
            mb: [3, null, 4],
          }}
        >
          Moderate
        </Heading>
        <Flex>
          <Link sx={{ mr: [4], variant: "links.nav" }} to={`${match.url}`}>
            Unmoderated
          </Link>
          <Link sx={{ mr: [4], variant: "links.nav" }} to={`${match.url}/accepted`}>
            Accepted
          </Link>
          <Link sx={{ mr: [4], variant: "links.nav" }} to={`${match.url}/rejected`}>
            Rejected
          </Link>
        </Flex>
        <Switch>
          <Redirect from="/:url*(/+)" to={match.path.slice(0, -1)} />
          <Route exact path={`${match.url}`} component={ModerateCommentsTodo} />
          <Route exact path={`${match.url}/accepted`} component={ModerateCommentsAccepted} />
          <Route exact path={`${match.url}/rejected`} component={ModerateCommentsRejected} />
        </Switch>
      </Box>
    );
  }
}

export default CommentModeration;

// <NavTab
//   active={this.props.routes[3].path ? false : true}
//   url={`/m/${this.props.params.conversation_id}/comments/`}
//   empty={0}
//   text="Unmoderated"
//   number={
//     this.props.unmoderated.unmoderated_comments
//       ? this.props.unmoderated.unmoderated_comments.length
//       : "..."
//   }
// />
// <NavTab
//   active={this.props.routes[3].path === "accepted"}
//   url={`/m/${this.props.params.conversation_id}/comments/accepted`}
//   empty={0}
//   text="Accepted"
//   number={
//     this.props.accepted.accepted_comments
//       ? this.props.accepted.accepted_comments.length
//       : "..."
//   }
// />
// <NavTab
//   active={this.props.routes[3].path === "rejected"}
//   url={`/m/${this.props.params.conversation_id}/comments/rejected`}
//   empty={0}
//   text="Rejected"
//   number={
//     this.props.rejected.rejected_comments
//       ? this.props.rejected.rejected_comments.length
//       : "..."
//   }
// />

// </Flex>
