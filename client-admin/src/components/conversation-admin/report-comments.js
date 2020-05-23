// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import _ from "lodash";
import ComponentHelpers from "../../util/component-helpers";
import Flex from "../framework/flex";
import NavTab from "../framework/nav-tab";
import NoPermission from "./no-permission";
import PolisNet from "../../util/net";
import Radium from "radium";
import React from "react";
import { connect } from "react-redux";
import { Link } from "react-router-dom";
import { populateAllCommentStores } from "../../actions";

const mapStateToProps = (state, ownProps) => {
  return {
    unmoderated: state.mod_comments_unmoderated,
    accepted: state.mod_comments_accepted,
    rejected: state.mod_comments_rejected,
    seed: state.seed_comments,
  };
};

const pollFrequency = 7000;

@connect((state) => state.zid_metadata)
@connect(mapStateToProps)
@Radium
class CommentModeration extends React.Component {
  getStyles() {
    return {
      navContainer: {
        margin: "10px 20px 20px 20px",
      },
    };
  }
  loadComments() {
    let commentsPromise = PolisNet.polisGet("/api/v3/comments", {
      include_social: true,
      moderation: true,
      modIn: true,
      conversation_id: this.props.params.conversation_id,
      report_id: this.props.params.report_id,
    });
    commentsPromise.then((comments) => {
      let included = comments.filter((c) => {
        return c.includeInReport;
      });
      let excluded = comments.filter((c) => {
        return !c.includeInReport;
      });
      this.setState({
        loading: false,
        includedComments: included,
        excludedComments: excluded,
      });
    });
  }
  componentWillMount() {
    this.loadComments();
    this.getCommentsRepeatedly = setInterval(() => {
      this.loadComments();
    }, pollFrequency);
  }
  componentWillUnmount() {
    clearInterval(this.getCommentsRepeatedly);
  }
  commentWasExcluded(excluded) {
    this.state.excludedComments.push(excluded);
    this.setState({
      excludedComments: this.state.excludedComments,
      includedComments: this.state.includedComments.filter((c) => {
        return c.tid !== excluded.tid;
      }),
    });
    PolisNet.polisPost("/api/v3/reportCommentSelections", {
      include: false,
      tid: excluded.tid,
      conversation_id: this.props.params.conversation_id,
      report_id: this.props.params.report_id,
    });
  }
  commentWasIncluded(included) {
    this.state.includedComments.push(included);
    this.setState({
      includedComments: this.state.includedComments,
      excludedComments: this.state.excludedComments.filter((c) => {
        return c.tid !== included.tid;
      }),
    });
    PolisNet.polisPost("/api/v3/reportCommentSelections", {
      include: true,
      tid: included.tid,
      conversation_id: this.props.params.conversation_id,
      report_id: this.props.params.report_id,
    });
  }
  render() {
    if (ComponentHelpers.shouldShowPermissionsError(this.props)) {
      return <NoPermission />;
    }

    const styles = this.getStyles();
    const numRouteElements = this.props.routes.length;

    return (
      <div>
        <Flex wrap="wrap" justifyContent="flex-start" styleOverrides={styles.navContainer}>
          <NavTab
            active={this.props.routes[numRouteElements - 1].path === "included"}
            url={`/m/${this.props.params.conversation_id}/reports/${this.props.params.report_id}/comments/included`}
            empty={0}
            text="Included"
            number={this.state.includedComments ? this.state.includedComments.length : "..."}
          />
          <NavTab
            active={this.props.routes[numRouteElements - 1].path === "excluded"}
            url={`/m/${this.props.params.conversation_id}/reports/${this.props.params.report_id}/comments/excluded`}
            empty={0}
            text="Excluded"
            number={this.state.excludedComments ? this.state.excludedComments.length : "..."}
          />
        </Flex>

        {React.cloneElement(this.props.children, {
          excludedComments: this.state.excludedComments,
          includedComments: this.state.includedComments,
          commentWasIncluded: this.commentWasIncluded.bind(this),
          commentWasExcluded: this.commentWasExcluded.bind(this),
        })}
      </div>
    );
  }
}

export default CommentModeration;

// <p style={{fontSize: 12}}>
//   {"Read about "}
//   <a
//     href="http://docs.pol.is/usage/CommentModeration.html">
//       {"comment moderation"}
//   </a>
//   {" and "}
//   <a
//     href="http://docs.pol.is/usage/SeedComments.html">
//       {"seed comments"}
//   </a>
//   {" at docs.pol.is"}
// </p>

/*
  todo
    * full screen one at a time zen mode for moderation with counter
    * new comments come in like tweets do as to avoid scroll
    * the set interval here covers over what would otherwise be complicated http... maybe in the future we'll do that right and duplicate comment state on client.
    * add conversation meta here to show whether strict or not
*/
