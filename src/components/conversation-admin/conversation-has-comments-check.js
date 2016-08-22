import _ from "lodash";
import Comment from "./comment";
import Flex from "../framework/flex";
import Radium from "radium";
import React from "react";
import Spinner from "../framework/spinner";
import strings from "../../strings/strings";
import { connect } from "react-redux";
import { populateAllCommentStores, changeCommentStatusToRejected } from '../../actions';

@connect(state => state.mod_comments_accepted)
@connect(state => state.mod_comments_rejected)
@connect(state => state.mod_comments_unmoderated)
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
    const numVisible = numAccepted + (isStrictMod ?  0 : numUnmoderated);

    let s;
    if (numVisible === 0) {
      if (isStrictMod && numUnmoderated > 0) {
        s = strings("share_but_no_visible_comments_warning");
      } else {
        s = strings("share_but_no_comments_warning");
      }
    } else {
      s = "ok";
    }
    return <div>{s}</div>;
  }
  renderSpinner() {
    return (
      <Flex>
        <Spinner/>
        <span style={{
            marginLeft: 10,
            position: "relative",
            top: -2
          }}> Loading accepted comments... </span>
      </Flex>
    )
  }
  render() {
    return (
      <div>
        <div>
          {
            (this.props.accepted_comments !== null && this.props.rejected_comments !== null) ?
              this.createCommentMarkup() :
              this.renderSpinner()
          }
        </div>
      </div>
    );
  }
}

export default ConversationHasCommentsCheck;
