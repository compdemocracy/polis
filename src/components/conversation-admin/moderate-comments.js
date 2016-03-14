import React from "react";
import { connect } from "react-redux";
import { populateAllCommentStores } from "../../actions";
import Radium from "radium";
import _ from "lodash";
import { Link } from "react-router";
import Flex from "../framework/flex";
import NavTab from "../framework/nav-tab";

const mapStateToProps = (state, ownProps) => {
  return {
    unmoderated: state.mod_comments_unmoderated,
    accepted: state.mod_comments_accepted,
    rejected: state.mod_comments_rejected,
    seed: state.seed_comments
  };
};

const pollFrequency = 7000;

@connect(mapStateToProps)
@Radium
class CommentModeration extends React.Component {
  getStyles() {
    return {
      navContainer: {
        margin: "10px 20px 20px 20px",
      }
    };
  }
  loadComments() {
    this.props.dispatch(
      populateAllCommentStores(this.props.params.conversation_id)
    );
  }
  componentWillMount() {
    this.getCommentsRepeatedly = setInterval(() => {
      this.loadComments();
    }, pollFrequency);
  }
  componentWillUnmount() {
    clearInterval(this.getCommentsRepeatedly);
  }
  render() {
    const styles = this.getStyles();
    return (
      <div>
        <Flex
          wrap="wrap"
          justifyContent="space-between"
          styleOverrides={styles.navContainer}>
          <NavTab
            active={this.props.routes[3].path ? false : true}
            url={`/m/${this.props.params.conversation_id}/comments/`}
            text="Unmoderated"
            number={
              this.props.unmoderated.unmoderated_comments ?
                this.props.unmoderated.unmoderated_comments.length :
                "..."
              }/>
          <NavTab
            active={this.props.routes[3].path === "accepted"}
            url={`/m/${this.props.params.conversation_id}/comments/accepted`}
            text="Accepted"
            number={
              this.props.accepted.accepted_comments ?
                this.props.accepted.accepted_comments.length :
                "..."
              }/>
          <NavTab
            active={this.props.routes[3].path === "rejected"}
            url={`/m/${this.props.params.conversation_id}/comments/rejected`}
            text="Rejected"
            number={
              this.props.rejected.rejected_comments ?
                this.props.rejected.rejected_comments.length :
                "..."
              }/>
          <NavTab
            active={this.props.routes[3].path === "seed"}
            url={`/m/${this.props.params.conversation_id}/comments/seed`}
            text="Seed"/>
          <NavTab
            active={this.props.routes[3].path === "seed_tweet"}
            url={`/m/${this.props.params.conversation_id}/comments/seed_tweet`}
            text="Seed Tweet"/>
        </Flex>
        {this.props.children}
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
