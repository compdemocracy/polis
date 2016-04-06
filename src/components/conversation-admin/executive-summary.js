import React from "react";
import Radium from "radium";
import _ from "lodash";
// import Flex from "./framework/flex";
import { connect } from "react-redux";
import {
  populateCommentsStore,
  populateMathStore,
  populateParticipantsStore
} from "../../actions";
import ParticipantHeader from "./participant-header";

@connect((state) => {
  return {
    comments: state.comments,
    math: state.math,
    participants: state.participants
  };
})
@Radium
class ExecutiveSummary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {

    };
  }
  static propTypes = {
    /* react */
    dispatch: React.PropTypes.func,
    params: React.PropTypes.object,
    routes: React.PropTypes.array,
    /* component api */
    style: React.PropTypes.object,
    math: React.PropTypes.object,
    comments: React.PropTypes.object
    // foo: React.PropTypes.string
  }
  static defaultProps = {
    // foo: "bar"
  }
  componentWillMount() {
    this.props.dispatch(populateCommentsStore(this.props.params.conversation_id));
    this.props.dispatch(populateMathStore(this.props.params.conversation_id));
    this.props.dispatch(populateParticipantsStore(this.props.params.conversation_id));
  }
  getStyles() {
    return {
      base: {

      },
      card: {
        margin: "10px 20px 10px 20px",
        backgroundColor: "rgb(253,253,253)",
        borderRadius: 3,
        padding: 10,
        WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
        BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)"
      },
      comment: {
        fontWeight: 300,
        borderLeft: "3px solid rgb(150,150,150)",
        paddingLeft: 10,
        marginLeft: 20
      }
    };
  }
  getConsensusAgreeComments() {
    const comments = this.props.comments.comments;
    const math = this.props.math.math;
    const styles = this.getStyles();
    return math.consensus.agree.map((comment) => {
      return (
        <div>
          {
            comments[comment.tid].social ?
              <ParticipantHeader {...comments[comment.tid].social} /> :
                "Anonymous"
          }
          <p style={styles.comment}>{comments[comment.tid].txt}</p>
        </div>
      );
    });
  }
  getConsensusDisagreeComments() {
    const comments = this.props.comments.comments;
    const math = this.props.math.math;
    const styles = this.getStyles();
    return math.consensus.disagree.map((comment) => {
      return (
        <div>
          {
            comments[comment.tid].social ?
              <ParticipantHeader {...comments[comment.tid].social} /> :
                "Anonymous"
          }
          <p style={styles.comment}>{comments[comment.tid].txt}</p>
        </div>
      );
    });
  }
  getGroupComments() {
    // const comments = this.props.comments.comments;
    const math = this.props.math.math;
    return math["group-clusters"].map((group, i) => {
      return (
        <p> Group {i} </p>
      );
    });
  }
  summary() {
    const comments = this.props.comments.comments;
    const math = this.props.math.math;
    return (
      <div>
        <p> Out of {math["n-cmts"]} comments submitted, the most agreed upon comment[s]: </p>
        {this.getConsensusAgreeComments()}
        The most disagreed upon comment[s]:
        {this.getConsensusDisagreeComments()}
        There were {math["group-clusters"].length} groups
        {this.getGroupComments()}
      </div>
    );
  }
  render() {
    console.log('summary',this.props)
    const styles = this.getStyles();
    const comments = this.props.comments.comments;
    const math = this.props.math.math;
    return (
      <div style={[
        styles.card,
        this.props.style
      ]}>
        {this.props.math.loading || this.props.comments.loading ? "Loading... " : ""}
        {this.props.math.error || this.props.comments.error ? "Error loading data" : ""}
        {!this.props.math.loading && !this.props.comments.loading ? this.summary() : ""}
      </div>
    );
  }
}

export default ExecutiveSummary;
