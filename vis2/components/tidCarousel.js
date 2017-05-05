import React from "react";
import * as globals from "./globals";

class TidCarousel extends React.Component {

  render() {
    return (
      <div style={{
        display: "flex",
        paddingLeft: 20,
        paddingRight: 20,
        marginTop: 10
        }}>
        <p style={{
          fontSize: 18,
          fontWeight: 500,
          position: "relative",
          top: 5,
          marginRight: 20
          }}> Comments: </p>
        <div style={{
          borderRadius: 3,
          border: "1px solid rgb(200,200,200)",
          overflow: "hidden",
          width: "99%"
          }}>
          <div style={{
            width: "100%",
            padding: 10,
            overflowX: "scroll",
            overflowY: "hidden",
            boxShadow: "inset 1px 0px 5px 1px rgba(232,232,232,1)",
            }}>
            {this.props.commentsToShow ? this.props.commentsToShow.map((c) => { return (
              <span
                onClick={this.props.handleCommentClick(c)}
                style={{
                  cursor: "pointer",
                  margin: 5,
                  padding: 5,
                  backgroundColor: "rgb(240,240,240)",
                  borderRadius: 3,
                  border: (this.props.selectedComment && this.props.selectedComment.tid === c.tid) ? "2px gray solid": "2px white solid",
                }}
                key={c.tid}>
                {c.tid}
              </span>
            )}) : ""}
          </div>
        </div>
      </div>
    )
  }
}

export default TidCarousel;
