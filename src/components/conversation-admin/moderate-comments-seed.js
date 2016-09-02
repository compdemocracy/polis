import React from "react";
import { connect } from "react-redux";
import { handleSeedCommentSubmit, seedCommentChanged } from "../../actions";
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
  seedForm: {
    width: "100%",
    maxWidth: 400,
    resize: "none",
    border: "1px solid rgb(200,200,200)",
    marginBottom: 15,
    borderRadius: 3,
    minHeight: 100,
    fontSize: 16,
    fontWeight: 300,
    padding: 10
  },
};

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
      is_seed: true
    };
    this.props.dispatch(handleSeedCommentSubmit(comment))
  }
  handleTextareaChange(e) {
    this.props.dispatch(seedCommentChanged(e.target.value));
  }
  getButtonText() {
    let text = "Submit";

    if (this.props.success) {
      text = "Success!";
    }

    if (this.props.loading) {
      text = "Saving...";
    }

    return text;
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
            onChange={this.handleTextareaChange.bind(this)}
            value={this.props.seedText}
            style={styles.seedForm}
            ref="seed_form"/>
        </div>
        <div>
          <Button
            style={{
              backgroundColor: "#03a9f4",
              color: "white",
            }}
            onClick={this.handleSubmitSeed.bind(this)}>
            {this.getButtonText()}
          </Button>
          {this.props.error ? <p>{strings(this.props.error)}</p> : ""}
        </div>
      </div>
    );
  }
}

export default ModerateCommentsSeed;
