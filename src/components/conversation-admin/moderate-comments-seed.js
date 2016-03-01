import React from "react";
import { connect } from "react-redux";
import { handleSeedCommentSubmit } from "../../actions";
import Radium from "radium";
import _ from "lodash";
import Button from "../framework/generic-button";

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
    const comment = {
      txt: this.refs.seed_form.value,
      pid: "mypid",
      conversation_id: this.props.params.conversation_id,
      vote: 0,
      prepop: true
    }
    this.props.dispatch(handleSeedCommentSubmit(comment))
  }
  handleTextareaChange() {

  }
  render() {
    return (
      <div style={styles.card}>
        <p style={{
          marginTop: 5,
          fontSize: 16
        }}> Add comments for participants to vote on: </p>
        <div>
          <textarea
            onChange={this.handleTextareaChange}
            style={{
              width: "100%",
              maxWidth: 400,
              resize: "none",
              border: "1px solid lightgrey",
              marginBottom: 15,
              backgroundColor: "rgb(240,240,240)",
              borderRadius: 3,
              minHeight: 100,
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
            Submit
          </Button>
        </div>
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
