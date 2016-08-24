import _ from "lodash";
import ConversationHasCommentsCheck from "./conversation-has-comments-check";
import Highlight from "react-highlight";
import Radium from "radium";
import React from "react";
import { connect } from "react-redux";
import { Link } from "react-router";


const styles = {
  card: {
    margin: "10px 20px 10px 20px",
    backgroundColor: "rgb(253,253,253)",
    borderRadius: 3,
    padding: "10px 10px",
    WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
    BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)"
  },
}

@connect(state => state.zid_metadata)
@Radium
class ShareAndEmbed extends React.Component {
  constructEmbeddedOnMarkup() {
    return (
      <p >{"Embedded on: "}
        <a style={{color: "black"}} target="blank" href={this.props.zid_metadata.parent_url}>
          {this.props.zid_metadata.parent_url}
        </a>
      </p>
    )
  }
  render() {
    return (
      <div>
        <ConversationHasCommentsCheck
          conversation_id={this.props.params.conversation_id}
          strict_moderation={this.props.zid_metadata.strict_moderation}/>
        <div style={styles.card}>
          <p style={{
            fontSize: 24,
            fontWeight: 300,
            marginTop: 0
            }}> {"Share"} </p>
          <p>
            <a
              style={{fontSize: 36, color: "black"}}
              target="blank"
              href={"https://pol.is/" + this.props.params.conversation_id}>
              {"pol.is/" + this.props.params.conversation_id}
            </a>
          </p>
        </div>
        <div style={styles.card}>
          <p style={{
            fontSize: 24,
            fontWeight: 300,
            marginTop: 0

            }}> {"Embed"} </p>
          <div style={{
            background: "rgb(238,238,238)",
            display: "inline-block",
            padding: "0px 20px",
            borderRadius: 3
            }}>
            <Highlight>
            {"<div"}
            {" class='polis'"}
            {" data-conversation_id='"+this.props.params.conversation_id+"'>"}
            {"</div>\n"}
            {"<script async='true' src='https://pol.is/embed.js'></script>"}
            </Highlight>
          </div>
          <p style={{fontWeight: 300}}>
            {
              "This embed code can only be used to embed a single conversation. "
            }
            <Link to="integrate">I want to integrate pol.is on my entire site.</Link>
          </p>
          <div>
            {
              this.props.zid_metadata.parent_url ?
                this.constructEmbeddedOnMarkup() : ""
            }
          </div>
        </div>
      </div>
    );
  }
}

export default ShareAndEmbed;

/* todo - consider         <p> show all parent urls - maybe there are multiple places it is embedded. need to keep up</p> */
