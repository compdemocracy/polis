import React from "react";
import _ from "lodash";
import Logo from "./coinLogo";
import Gear from "./gear";

class Header extends React.Component {
  render() {
    return (
      <div>
      <div style={{
        maxWidth: 768,
        padding: "0px 10px",
        margin: "0 auto",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}>
        <div style={{width: "480px", 
                     margin:"0 auto"}}>
          {this.props.is_embedded ? "" : <Logo/>}
          <h2 style={{textAlign: "center",
                      fontSize: "2.2em"}}>OFFICIAL: SENSITIVE</h2>
          {this.props.is_owner ? <Gear conversation_id={this.props.conversation_id}/> : ""}
        </div>
      </div>
      </div>
    )
  }
}

export default Header;
