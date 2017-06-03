import _ from "lodash";
import React from "react";
import * as globals from "./globals";
import BarChart from "./barChart";

const checkmark = "M1299 813l-422 422q-19 19-45 19t-45-19l-294-294q-19-19-19-45t19-45l102-102q19-19 45-19t45 19l147 147 275-275q19-19 45-19t45 19l102 102q19 19 19 45t-19 45zm141 83q0-148-73-273t-198-198-273-73-273 73-198 198-73 273 73 273 198 198 273 73 273-73 198-198 73-273zm224 0q0 209-103 385.5t-279.5 279.5-385.5 103-385.5-103-279.5-279.5-103-385.5 103-385.5 279.5-279.5 385.5-103 385.5 103 279.5 279.5 103 385.5z";
const ban = "M1440 893q0-161-87-295l-754 753q137 89 297 89 111 0 211.5-43.5t173.5-116.5 116-174.5 43-212.5zm-999 299l755-754q-135-91-300-91-148 0-273 73t-198 199-73 274q0 162 89 299zm1223-299q0 157-61 300t-163.5 246-245 164-298.5 61-298.5-61-245-164-163.5-246-61-300 61-299.5 163.5-245.5 245-164 298.5-61 298.5 61 245 164 163.5 245.5 61 299.5z";

const DataSentence = ({math, selectedTidCuration, selectedComment, repfulFor, Strings}) => {

  let markup = null;

  if (_.isNumber(selectedTidCuration)) {
    const gid = selectedTidCuration;
    const tid = selectedComment.tid;
    const groupVotes = math["group-votes"][gid];

    const repness = _.find(math.repness[gid], (r) => { return r.tid === selectedComment.tid })
    let repfulForAgree = repness["repful-for"] === "agree";
    const v = groupVotes.votes[tid];
    const denominator = v.S; // (seen)
    if (repness["best-agree"] && (v.A > 0)) {
      repfulForAgree = true;
    }
    // const denominator = info.count; // or maybe v.S (seen)
    // const percent = repfulForAgree ?
    //   "<i class='fa fa-check-circle-o'></i> " + ((v.A / denominator * 100) >> 0) :
    //   "<i class='fa fa-ban'></i> " + ((v.D / denominator * 100) >> 0);
    const percent = repfulForAgree ? ((v.A / denominator * 100) >> 0) : ((v.D / denominator * 100) >> 0);


    // var count = repfulForAgree ? v.A : v.D;
    // var createdString = (new Date(c.get("created") * 1)).toString().match(/(.*?) [0-9]+:/)[1];

    var s = repfulForAgree ? Strings.pctAgreedOfGroupLong : Strings.pctDisagreedOfGroupLong;
    s = s.replace("{{pct}}", percent);
    s = s.replace("{{group}}", globals.groupLabels[selectedTidCuration]);
    s = s.replace("{{comment_id}}", tid);

    markup = (
      <div style={{display: "flex"}}>
        <svg height={40} style={{
            display: "inline",
            marginRight: 10,
            fill: repfulForAgree ? globals.colors.agree : globals.colors.disagree
          }} viewBox="0 0 1792 1792">
          <path d={repfulForAgree ? checkmark : ban}/>
          </svg>
        <p style={{
            fontSize: 14,
            fontFamily: "Helvetica",
            fontWeight: 500,
            maxWidth: 240,
            color: "rgb(180,180,180)"
          }}>
          {s}
        </p>
      </div>
    )
  } else if (selectedTidCuration === globals.tidCuration.majority) {
    const repfulForAgree = _.find(math.consensus.agree, (r) => { return r.tid === selectedComment.tid });
    const repfulForDisagree = _.find(math.consensus.disagree, (r) => { return r.tid === selectedComment.tid });
    const repness = repfulForAgree || repfulForDisagree;

    const percent = (repness["n-success"] / repness["n-trials"] * 100) >> 0;

    let s = repfulForAgree ? Strings.pctAgreedLong : Strings.pctDisagreedLong;
    s = s.replace("{{pct}}", percent);
    s = s.replace("{{comment_id}}", selectedComment.tid);

    markup = (
      <div style={{display: "flex"}}>
        <svg height={40} style={{
            display: "inline",
            marginRight: 10,
            fill: repfulForAgree ? globals.colors.agree : globals.colors.disagree
          }} viewBox="0 0 1792 1792">
          <path d={repfulForAgree ? checkmark : ban}/>
          </svg>
        <p style={{
            fontSize: 14,
            fontFamily: "Helvetica",
            fontWeight: 500,
            maxWidth: 240,
            color: "rgb(180,180,180)"
          }}>
          {s}
        </p>
      </div>
    )
  }

  return markup;
}

class ExploreTid extends React.Component {

  handleAgree() {
    this.props.onVoteClicked({
      tid: this.props.selectedComment.tid,
      vote: window.polisTypes.reactions.pull,
    });
  }
  handleDisagree() {
    this.props.onVoteClicked({
      tid: this.props.selectedComment.tid,
      vote: window.polisTypes.reactions.push,
    });
  }
  handlePass() {
    this.props.onVoteClicked({
      tid: this.props.selectedComment.tid,
      vote: window.polisTypes.reactions.pass,
    });
  }

  createChangeVotesElements() {
    let currentVote = null;
    if (this.props.selectedComment) {
      let selectedTid = this.props.selectedComment.tid;
      let voteForSelectedComment = _.find(this.props.votesByMe, (v) => {
        return v.tid === selectedTid;
      });
      currentVote = voteForSelectedComment && voteForSelectedComment.vote;
    }

    let agreeButton = (
      <button style={{
        border: "none",
        fontSize: 14,
        backgroundColor: "transparent",
        fontWeight: "bold",
        cursor: "pointer",
      }}
      onClick={this.handleAgree.bind(this)}>
      <svg
        style={{
          marginRight: 3,
          position: "relative",
          top: 2,
          display: "inline-block"
        }} fill="rgb(200,0,0)" width="15" viewBox="0 0 1792 1792"><path d="M1299 813l-422 422q-19 19-45 19t-45-19l-294-294q-19-19-19-45t19-45l102-102q19-19 45-19t45 19l147 147 275-275q19-19 45-19t45 19l102 102q19 19 19 45t-19 45zm141 83q0-148-73-273t-198-198-273-73-273 73-198 198-73 273 73 273 198 198 273 73 273-73 198-198 73-273zm224 0q0 209-103 385.5t-279.5 279.5-385.5 103-385.5-103-279.5-279.5-103-385.5 103-385.5 279.5-279.5 385.5-103 385.5 103 279.5 279.5 103 385.5z"/></svg>
      Agree
    </button>);

    let disagreeButton = (
      <button style={{
        border: "none",
        fontSize: 14,
        backgroundColor: "transparent",
        fontWeight: "bold",
        cursor: "pointer",
      }}
      onClick={this.handleDisagree.bind(this)}>
        <svg
          style={{
            marginRight: 3,
            position: "relative",
            top: 2,
            display: "inline-block"
          }} fill="rgb(200,0,0)" width="15" viewBox="0 0 1792 1792"><path d="M1440 893q0-161-87-295l-754 753q137 89 297 89 111 0 211.5-43.5t173.5-116.5 116-174.5 43-212.5zm-999 299l755-754q-135-91-300-91-148 0-273 73t-198 199-73 274q0 162 89 299zm1223-299q0 157-61 300t-163.5 246-245 164-298.5 61-298.5-61-245-164-163.5-246-61-300 61-299.5 163.5-245.5 245-164 298.5-61 298.5 61 245 164 163.5 245.5 61 299.5z"/></svg>
        Disagree
      </button>
    );

    let passButton = (
      <button
        style={{
          border: "none",
          fontSize: 14,
          backgroundColor: "transparent",
          fontWeight: "bold",
          cursor: "pointer",
        }}
        onClick={this.handlePass.bind(this)}
      >
        Pass
      </button>
    );

    // Conditionally show change votes buttons
    let buttons = null;
    if (window.preload.firstConv.is_active) {
      if (!_.isNumber(currentVote)) {
        buttons = <span>{agreeButton} {disagreeButton} {passButton}</span>
      } else if (currentVote === window.polisTypes.reactions.pass) {
        buttons = <span>Change vote: {agreeButton} {disagreeButton}</span>
      } else if (currentVote === window.polisTypes.reactions.pull) {
        buttons = <span>Change vote: {disagreeButton} {passButton}</span>
      } else if (currentVote === window.polisTypes.reactions.push) {
        buttons = <span>Change vote: {agreeButton} {passButton}</span>
      }
    }

    let changeVotesElements = null;
    if (!_.isNumber(currentVote)) {
      changeVotesElements = <span> {buttons}</span>
    } else if (currentVote === window.polisTypes.reactions.pass) {
      changeVotesElements = <span> You passed. {buttons}</span>
    } else if (currentVote === window.polisTypes.reactions.pull) {
      changeVotesElements = <span> You agreed. {buttons}</span>
    } else if (currentVote === window.polisTypes.reactions.push) {
      changeVotesElements = <span> You disagreed. {buttons}</span>
    }

    return (
      <div style={{display: "flex", justifyContent: "flex-start"}}>
        {changeVotesElements}
      </div>
    )
  }
  render() {
    if (!this.props.selectedComment) {return null}
    return (
      <div style={{
          borderRadius: 4,
          padding: "10px 10px 10px 10px",
          width:"100%",
          minHeight: 145,
          textAlign: "left",
          display: "flex",
          justifyContent:"center",
          alignItems: "baseline",
        }}>
        <p style={{
            fontSize: 18,
            marginRight: 20,
            fontWeight: "700",
          }}>
          {this.props.selectedComment ? "#" + this.props.selectedComment.tid : null}
        </p>
        <div style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "space-between",
            height: "100%",
          }}>
          <p style={{
            width: 360,
            fontSize: 18,
            fontFamily: "Georgia, serif",
          }}>
            {this.props.selectedComment ? this.props.selectedComment.txt : null}
          </p>
          <DataSentence
            math={this.props.math}
            selectedComment={this.props.selectedComment}
            selectedTidCuration={this.props.selectedTidCuration}
            Strings={this.props.Strings}
            />
          {/*this.createChangeVotesElements()*/}
        </div>
      </div>
    )
  }
}

export default ExploreTid;


//
// {/*  <svg
//     style={{
//       position: "relative",
//       top: -2
//     }}
//     width={225}
//     height={70}>
//     <BarChart
//       selectedComment={this.props.selectedComment}
//       allComments={this.props.comments}
//       groups={window.preload.firstMath["group-votes"]}
//       />
//   </svg>
// */}
// {/*
//   <button style={{
//     border: "none",
//     backgroundColor: "transparent",
//     width: 12,
//     height: 12,
//     cursor: "pointer",
//     position: "relative",
//     right: 8,
//   }}
// onClick={this.props.handleReturnToVoteClicked}>
// <svg
//   viewPort="0 0 12 12" >
//     <line x1="1" y1="11"
//           x2="11" y2="1"
//           stroke="black"
//           strokeWidth="2"/>
//     <line x1="1" y1="1"
//           x2="11" y2="11"
//           stroke="black"
//           strokeWidth="2"/>
//   </svg>
// </button>
// */}
