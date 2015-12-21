import React from "react";
import { connect } from "react-redux";
import { handleSeedCommentSubmit } from "../../actions";
import Radium from "radium";
import _ from "lodash";

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
  render() {
    return (
      <div>
        <div>
          <textarea
            style={{
              width: "100%",
              maxWidth: 400,
              resize: "none",
              border: "1px solid lightgrey",
              borderRadius: 3,
              minHeight: 100,
              fontSize: 16,
              padding: 10
            }}
            ref="seed_form"/>
        </div>
        <div>
          <button
            style={{
              padding: "15px 30px",
              background: "rgb(230,230,230)",
              color: "rgb(160,160,160)",
              border: "none",
              borderRadius: 3,
              fontSize: 16,
              cursor: "pointer"
            }}
            onClick={this.handleSubmitSeed.bind(this)}>
            Submit
          </button>
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