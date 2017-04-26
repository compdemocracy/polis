import _ from "lodash";
import React from "react";
import * as globals from "./globals";
import BarChart from "./barChart";

class ExploreTid extends React.Component {

  render() {

    let currentVote = null;
    if (this.props.selectedComment) {
      let selectedTid = this.props.selectedComment.tid;
      console.log('selectedTid',selectedTid);
      let voteForSelectedComment = _.find(this.props.votesByMe, (v) => {
        return v.tid === selectedTid;
      });
      console.log('this.props.votesByMe',this.props.votesByMe);


      console.log('voteForSelectedComment',voteForSelectedComment);

      currentVote = voteForSelectedComment && voteForSelectedComment.vote;
      console.log('currentVote',currentVote);
    }


    let agreeButton = (<button style={{
        border: "none",
        borderRadius: 3,
        backgroundColor: "green",
        color: "white",
        fontWeight: "bold",
        cursor: "pointer",
        padding: "10px 20px"
      }}
      onClick={this.props.handleChangeToAgreeClicked}>
      Agree
    </button>);

    let disagreeButton = (<button style={{
        border: "none",
        borderRadius: 3,
        backgroundColor: "red",
        color: "white",
        fontWeight: "bold",
        cursor: "pointer",
        padding: "10px 20px"
      }}
      onClick={this.props.handleChangeToDisagreeClicked}>
      Disagree
    </button>);

    let passButton = (<button style={{
        border: "none",
        borderRadius: 3,
        backgroundColor: "lightgray",
        color: "white",
        fontWeight: "bold",
        cursor: "pointer",
        padding: "10px 20px"
      }}
      onClick={this.props.handleChangeToPassClicked}>
      Pass
    </button>);


    let changeVotesElements = null;
    if (_.isNull(currentVote)) {
      changeVotesElements = <p>"no vote yet"</p>;
    } else if (currentVote === window.polisTypes.reactions.pass) {
      changeVotesElements = <p> You: PASSED. Change your vote to {agreeButton} {disagreeButton}</p>
    } else if (currentVote === window.polisTypes.reactions.pull) {
      changeVotesElements = <p> You: AGREED. Change your vote to {disagreeButton} {passButton}</p>
    } else if (currentVote === window.polisTypes.reactions.push) {
      changeVotesElements = <p> You: DISAGREED. Change your vote to {agreeButton} {passButton}</p>
    }


    return (
      <div>
        <button style={{
            border: "none",
            borderRadius: 3,
            backgroundColor: "red",
            color: "white",
            fontWeight: "bold",
            cursor: "pointer",
            padding: "10px 20px"
          }}
          onClick={this.props.handleReturnToVoteClicked}>
          Back to voting
        </button>
        <p>
          Explore your previous votes.
          Who else agreed? Who disagreed?
          How do your perspectives compare?
        </p>
        <div style={{
            width:"100%",
            textAlign: "left",
            padding: "20px 0px 0px 10px",
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
            <p style={{
              color: "black",
              fontWeight: 700,
              fontSize: 10,
              fontFamily: "Helvetica, sans-serif"
            }}>TOTAL:</p>
            <svg width={260} height={100}> {/* put this inside barchart rendered conditionally ie., 'standalone=true' prop */}
              <BarChart
                selectedComment={this.props.selectedComment}
                allComments={this.props.comments}
                groups={window.preload.firstMath["group-votes"]}
                />
            </svg>
          </div>
        </div>
        {changeVotesElements}
      </div>
    )
  }
}

export default ExploreTid;
