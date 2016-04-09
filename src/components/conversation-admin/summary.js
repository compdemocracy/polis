import React from "react";
import Radium from "radium";
import _ from "lodash";
import { connect } from "react-redux";
import {
  populateCommentsStore,
  populateMathStore,
  populateParticipantsStore
} from "../../actions";
import Comment from "./summary-comment";
import Flex from '../framework/Flex';

@connect((state) => {
  return {
    comments: state.comments,
    math: state.math,
    participants: state.participants
  };
})
@Radium
class Summary extends React.Component {
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
  getConsensusAgreeComments() {
    const comments = this.props.comments.comments;
    const math = this.props.math.math;
    const styles = this.getStyles();
    return math.consensus.agree.map((comment, i) => {
      return (
        <Comment
          key={i}
          majority={true}
          agree={true}
          first={i === 0 ? true : false}
          {...comment}
          {...comments[comment.tid]} />
      );
    });
  }
  getConsensusDisagreeComments() {
    const comments = this.props.comments.comments;
    const math = this.props.math.math;
    const styles = this.getStyles();
    return math.consensus.disagree.map((comment, i) => {
      return (
        <Comment
          key={i}
          majority={true}
          {...comment}
          {...comments[comment.tid]} />
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
    const styles = this.getStyles();
    return (
      <span style={styles.text}>
        <p style={styles.text}>
          {`${math["n"]} people participated. `}
          {`There were ${math["n-cmts"]} comments submitted. `}
        </p>
        <p style={styles.sectionHeader}> The General Consensus </p>
        <span style={{lineHeight: 2.3}}>
          Across all {math["n"]} participants,
          <span> the most agreed upon </span>
          {math.consensus.agree.length > 1 ? " comments were: " : "comment was: "}
        </span>

        {this.getConsensusAgreeComments()}
        The most disagreed upon
        {math.consensus.disagree.length > 1 ? " comments were: " : "comment was: "}
        {this.getConsensusDisagreeComments()}

        <p style={styles.sectionHeader}> Opinion Groups </p>

        <p> There were {math["group-clusters"].length} groups. The largest had x, etc </p>
        {this.getGroupComments()}
      </span>
    );
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
      text: {
        fontWeight: 300,
        maxWidth: 600
      },
      mostAgreedUpon: {
        backgroundColor: "rgb()"
      },
      sectionHeader: {
        fontWeight: 900
      }
    };
  }
  render() {

    const styles = this.getStyles();
    const comments = this.props.comments.comments;
    const math = this.props.math.math;
    return (
      <Flex styleOverrides={styles.card}>
        {this.props.math.loading || this.props.comments.loading ? "Loading... " : ""}
        {this.props.math.error || this.props.comments.error ? "Error loading data" : ""}
        {!this.props.math.loading && !this.props.comments.loading ? this.summary() : ""}
      </Flex>
    );
  }
}

export default Summary;
