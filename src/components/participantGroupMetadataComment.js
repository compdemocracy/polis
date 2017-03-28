import React from "react";
import Flex from "./flex";
import * as globals from "./globals";

const ParticipantGroupMetadataComment = ({comment, ptptCount, groupVotesForThisGroup}) => {
  console.log(groupVotesForThisGroup, comment.tid)
    return (
      <Flex
        direction="column"
        justifyContent="space-between"
        styleOverrides={{
          width: 110,
          padding: 20,
          height: 110,
          marginTop: 20,
          marginRight: 20, 
          backgroundColor: "rgb(248,248,248)"
        }}>
        <p style={{margin: 0, fontSize: 36}}> {groupVotesForThisGroup.votes[comment.tid].A} </p>
        <p style={Object.assign({}, globals.paragraph, {
          fontSize: 14,
          margin: 0,
          textAlign: "center",
          lineHeight: 1.3,
          maxWidth: 120,
        })}>
          { comment.txt }
        </p>
        <p style={Object.assign({}, globals.paragraph, {
          fontSize: 10,
          margin: 0,
          textAlign: "center",
          lineHeight: 1.1,
          maxWidth: 120,
        })}>
          {groupVotesForThisGroup.votes[comment.tid].S} voted, {groupVotesForThisGroup.votes[comment.tid].A} agreed
          {": "}
          {Math.floor(groupVotesForThisGroup.votes[comment.tid].A / groupVotesForThisGroup.votes[comment.tid].S * 100) }
          %
        </p>
      </Flex>
    );
}

export default ParticipantGroupMetadataComment;

// <span style={{
//     width: 40,
//     textAlign: "right",
//     marginRight: 10,
//     fontFamily: globals.sans,
//     fontWeight: 700,
//     color: globals.tidGrey
//   }}>{this.props.formatTid(this.props.comment.tid)}</span>

// <p>{this.props.comment.demographics.gender}</p>
// <p>{this.props.comment.demographics.age}</p>

// {
//   showAsAnon ?
//     "Anonymous" :
//     <ParticipantHeader {...this.props.comment.social} />
// }
