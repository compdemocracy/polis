import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import Highlight from "react-highlight";

@connect(state => state.zid_metadata)
@Radium
class ShareAndEmbed extends React.Component {
  constructEmbeddedOnMarkup() {
    return (
      <p>{"Embedded on: "}
        <a target="blank" href={this.props.zid_metadata.parent_url}>
          {this.props.zid_metadata.parent_url}
        </a>
      </p>
    )
  }
  render() {
    return (
      <div>
        <p style={{
          fontSize: 36,
          fontWeight: 100
          }}>Share & Embed</p>
        <p style={{
          fontSize: 18,
          fontWeight: 500
          }}> {"Share this link: "} </p>
        <p>
          <a
            style={{textDecoration: "none", fontSize: 36}}
            target="blank"
            href={"https://pol.is/" + this.props.params.conversation_id}>
            {"pol.is/" + this.props.params.conversation_id}
          </a>
        </p>
        <p style={{
          marginTop: 40,
          fontSize: 18,
          fontWeight: 500
          }}> {"Paste this embed code into your site: "} </p>
        <div style={{
          background: "rgb(238,238,238)",
          display: "inline-block",
          padding: "0px 20px",
          borderRadius: 3
          }}>
          <Highlight>
          {"<div"}
          {" class='polis'"}
          {" data-conversation_id='" + this.props.params.conversation_id + "'>"}
          {"</div>\n"}
          {"<script async='true' src='https://pol.is/embed.js'></script>"}
          </Highlight>
        </div>
        <div>
          {
            this.props.zid_metadata.parent_url ?
              this.constructEmbeddedOnMarkup() : ""
          }
        </div>
        <div class="polis" data-conversation_id="747ajm"></div>

        <p style={{
          marginTop: 40,
          fontSize: 18,
          fontWeight: 500
          }}> See your conversation, live: </p>
        <iframe
          src={"https://pol.is/"+this.props.params.conversation_id}
          style={{
            minHeight: "1000px",
            width: "100%",
            border: "none"
          }}/>
      </div>
    );
  }
}

export default ShareAndEmbed;

/* todo - consider         <p> show all parent urls - maybe there are multiple places it is embedded. need to keep up</p> */