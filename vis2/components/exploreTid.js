import _ from "lodash";
import React from "react";
import * as globals from "./globals";
import BarChart from "./barChart";

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
        borderRadius: 3,
        backgroundColor: "green",
        color: "white",
        fontWeight: "bold",
        cursor: "pointer",
        padding: "10px 20px"
      }}
      onClick={this.handleAgree.bind(this)}>
      Agree
    </button>);

    let disagreeButton = (
      <button style={{
        border: "none",
        borderRadius: 3,
        backgroundColor: "red",
        color: "white",
        fontWeight: "bold",
        cursor: "pointer",
        padding: "10px 20px"
      }}
      onClick={this.handleDisagree.bind(this)}
    >
        Disagree
      </button>
    );

    let passButton = (
      <button
        style={{
          border: "none",
          borderRadius: 3,
          backgroundColor: "lightgray",
          color: "white",
          fontWeight: "bold",
          cursor: "pointer",
          padding: "10px 20px"
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
        buttons = <span>Change vote {agreeButton} {disagreeButton}</span>
      } else if (currentVote === window.polisTypes.reactions.pull) {
        buttons = <span>Change vote {disagreeButton} {passButton}</span>
      } else if (currentVote === window.polisTypes.reactions.push) {
        buttons = <span>Change vote {agreeButton} {passButton}</span>
      }
    }

    let changeVotesElements = null;
    if (!_.isNumber(currentVote)) {
      changeVotesElements = <span> {buttons}</span>
    } else if (currentVote === window.polisTypes.reactions.pass) {
      changeVotesElements = <span> You: PASSED. {buttons}</span>
    } else if (currentVote === window.polisTypes.reactions.pull) {
      changeVotesElements = <span> You: AGREED. {buttons}</span>
    } else if (currentVote === window.polisTypes.reactions.push) {
      changeVotesElements = <span> You: DISAGREED. {buttons}</span>
    }

    return (
      <div style={{display: "flex", justifyContent: "flex-start"}}>
        {changeVotesElements}
      </div>
    )

  }

  render() {

    return (
      <div style={{
          backgroundColor: "rgb(240,240,240)",
          padding: 10,
        }}>
        <div style={{
            width:"100%",
            textAlign: "left",
            display: "flex",
            justifyContent:"space-between",
            alignItems: "flex-start",
          }}>
          <p style={{fontSize: 36}}>
            {this.props.selectedComment ? "#" + this.props.selectedComment.tid : null}
          </p>
          <p style={{
            maxWidth: 300,
            fontSize: 14,
            fontFamily: "Georgia, serif",
            fontStyle: "italic"
          }}>
            {this.props.selectedComment ? this.props.selectedComment.txt : null}
          </p>
          <div style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center"
            }}>
            <svg width={260} height={100}> {/* put this inside barchart rendered conditionally ie., 'standalone=true' prop */}
              <BarChart
                selectedComment={this.props.selectedComment}
                allComments={this.props.comments}
                groups={window.preload.firstMath["group-votes"]}
                />
            </svg>
          </div>
          <button style={{
              border: "none",
              backgroundColor: "transparent",
              width: 12,
              height: 12,
              cursor: "pointer",
            }}
          onClick={this.props.handleReturnToVoteClicked}>
          <svg
            viewPort="0 0 12 12" >
              <line x1="1" y1="11"
                    x2="11" y2="1"
                    stroke="black"
                    strokeWidth="2"/>
              <line x1="1" y1="1"
                    x2="11" y2="11"
                    stroke="black"
                    strokeWidth="2"/>
            </svg>
          </button>
        </div>
        {this.createChangeVotesElements()}
      </div>
    )
  }
}

export default ExploreTid;
