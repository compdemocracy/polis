import React from "react";
import { connect } from "react-redux";
import { populateAllCommentStores } from "../../actions";
import Radium from "radium";
import _ from "lodash";
import { Link } from "react-router";
import Spinner from "../framework/spinner";

const mapStateToProps = (state, ownProps) => {
  return {
    unmoderated: state.mod_comments_unmoderated,
    accepted: state.mod_comments_accepted,
    rejected: state.mod_comments_rejected,
    seed: state.seed_comments
  }
}

@connect(mapStateToProps)
@Radium
class CommentModeration extends React.Component {
  loadComments() {
    this.props.dispatch(
      populateAllCommentStores(this.props.params.conversation)
    )
  }
  componentWillMount () {
    this.getCommentsRepeatedly = setInterval(()=>{
      this.loadComments()
    },2000);
  }
  componentWillUnmount() {
    clearInterval(this.getCommentsRepeatedly);
  }
  render() {
    const m = "/m/"+this.props.params.conversation+"/comments/";
    return (
      <div>
        <h1 style={{marginBottom: 10}}>Comment Moderation</h1>
        <div>
          <Link
            style={{
              marginLeft: -10,
              padding: 10,
              borderRadius: 3,
              cursor: "pointer",
              textDecoration: "none",
              fontWeight: 700
            }}
            to={m}>
              {"Todo "}
              {
                this.props.unmoderated.unmoderated_comments ?
                this.props.unmoderated.unmoderated_comments.length :
                "..."
              }
          </Link>
          <Link
            style={{
              padding: 10,
              borderRadius: 3,
              cursor: "pointer",
              textDecoration: "none",
              fontWeight: 700
            }}
            to={m + "accepted"}>
              {"Accepted "}
              {
                this.props.accepted.accepted_comments ?
                this.props.accepted.accepted_comments.length :
                "..."
              }
          </Link>
          <Link
            style={{
              padding: 10,
              borderRadius: 3,
              cursor: "pointer",
              textDecoration: "none",
              fontWeight: 700
            }}
            to={m + "rejected"}>
              {"Rejected "}
              {
                this.props.rejected.rejected_comments ?
                this.props.rejected.rejected_comments.length :
                "..."
            }
          </Link>
          <Link
            style={{
              padding: 10,
              borderRadius: 3,
              cursor: "pointer",
              textDecoration: "none",
              fontWeight: 700
            }}
            to={m + "seed"}>
              {
                "Seed"
              }
          </Link>
        </div>
        <p style={{fontSize: 12, marginBottom: 40}}>
          {"Read about "}
          <a
            href="http://docs.pol.is/usage/CommentModeration.html">
              {"comment moderation"}
          </a>
          {" and "}
          <a
            href="http://docs.pol.is/usage/SeedComments.html">
              {"seed comments"}
          </a>
          {" at docs.pol.is"}
        </p>
        {this.props.children}
      </div>
    );
  }
}

export default CommentModeration;


/*
  todo
    * full screen one at a time zen mode for moderation with counter
    * new comments come in like tweets do as to avoid scroll
    * the set interval here covers over what would otherwise be complicated http... maybe in the future we'll do that right and duplicate comment state on client.
    * add conversation meta here to show whether strict or not
*/