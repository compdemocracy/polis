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
        fontSize: 14,
        backgroundColor: "transparent",
        fontWeight: "bold",
        cursor: "pointer",
      }}
      onClick={this.handleAgree.bind(this)}>
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
      onClick={this.handleDisagree.bind(this)}
    >
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

    return (
      <div style={{
          backgroundColor: "rgb(247,247,247)",
          borderRadius: 4,
          padding: "10px 10px 10px 10px",
          width:"100%",
          minHeight: 160,
          textAlign: "left",
          display: "flex",
          justifyContent:"space-between",
          alignItems: "flex-start",
        }}>
        <p style={{
            fontSize: 24,
            fontWeight: "700",
            position: "relative",
            top: -5
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
            maxWidth: 300,
            fontSize: 14,
            fontFamily: "Georgia, serif",
          }}>
            {this.props.selectedComment ? this.props.selectedComment.txt : null}
          </p>
          {this.createChangeVotesElements()}
        </div>

          <svg
            style={{
              position: "relative",
              top: -2
            }}
            width={225}
            height={70}> {/* put this inside barchart rendered conditionally ie., 'standalone=true' prop */}
            <BarChart
              selectedComment={this.props.selectedComment}
              allComments={this.props.comments}
              groups={window.preload.firstMath["group-votes"]}
              />
          </svg>
        <button style={{
            border: "none",
            backgroundColor: "transparent",
            width: 12,
            height: 12,
            cursor: "pointer",
            position: "relative",
            right: 8,
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
    )
  }
}

export default ExploreTid;
