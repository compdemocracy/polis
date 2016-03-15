import React from "react";
import { connect } from "react-redux";
import { handleSeedCommentTweetSubmit } from "../../actions";
import Radium from "radium";
import _ from "lodash";
import Button from "../framework/generic-button";
import strings from "../../strings/strings";

const styles = {
  card: {
    margin: "10px 20px 10px 20px",
    backgroundColor: "rgb(253,253,253)",
    borderRadius: 3,
    padding: 10,
    WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
    BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)"
  },
}

@connect(state => state.seed_comments)
@Radium
class ModerateCommentsSeed extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      showErrorDialogue: false,
      showSuccessDialogue: false
    };
  }
  handleSubmitSeed () {
    var val = this.refs.seed_form.value;
    var match = val && val.match(/[a-zA-Z0-9]+$/);
    var tweet_id = "";
    if (match && match.length) {
      tweet_id = match[0];
    }

    const o = {
      twitter_tweet_id: tweet_id,
      conversation_id: this.props.params.conversation_id,
      vote: -1, // the tweeter of the tweet will auto-agree. An account will be created for them if needed.
      prepop: true
    }
    this.props.dispatch(handleSeedCommentTweetSubmit(o))
  }
  handleTextareaChange() {

  }
  render() {
    if (this.props.error) {
      console.dir();
    }
    return (
      <div style={styles.card}>
        <p style={{
          marginTop: 5,
          fontSize: 16
        }}> Paste in a Tweet URL. It will be imported for participants to vote on. </p>
        <div>
          <textarea
            onChange={this.handleTextareaChange}
            style={{
              width: "100%",
              rows: 1,
              maxlength: 200,
              maxWidth: 400,
              resize: "none",
              border: "1px solid lightgrey",
              marginBottom: 15,
              backgroundColor: "rgb(240,240,240)",
              borderRadius: 3,
              fontSize: 16,
              padding: 10
            }}
            ref="seed_form"/>
        </div>
        <div>
          <Button
            style={{
              backgroundColor: "#03a9f4",
              color: "white",
            }}
            onClick={this.handleSubmitSeed.bind(this)}>
            {this.props.pending ? "Submitting..." : "Submit tweet as comment"}
          </Button>
        </div>
        {this.props.error ? <div>{strings(this.props.error)}</div> : ""}
      </div>
    );
  }
}

export default ModerateCommentsSeed;

/*
  todo
    handle all validation niceties
    seed tweet
*/
