import React from "react";
import _ from "lodash";
import Logo from "./hexLogo";
import Gear from "./gear";

class Header extends React.Component {
  render() {
    return (
      <div style={{
        maxWidth: 768,
        padding: "20px 10px 0px 10px",
        margin: "auto",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}>
        <Logo/>
        <Gear/>
      </div>
    )
  }
}

export default Header;
