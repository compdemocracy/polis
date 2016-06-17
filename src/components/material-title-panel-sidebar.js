import React from "react";
import Awesome from "react-fontawesome";
import * as globals from "./framework/global-styles";
import HexLogoTinyLong from "./framework/hex-logo-tiny-long";

const styles = {
  root: {
    fontFamily: '"HelveticaNeue-Light", "Helvetica Neue Light", "Helvetica Neue", Helvetica, Arial, "Lucida Grande", sans-serif',
    fontWeight: 300,
  },
  header: {
    backgroundColor: "#03a9f4",
    color: "white",
    paddingTop: 4,
    fontSize: "1.5em",
  },
  linkout: {
    textDecoration: "none",
    color: "white"
  }
};

const MaterialTitlePanelSidebar = (props) => {

  const rootStyle = props.style ? {...styles.root, ...props.style} : styles.root;
  return (
    <div style={rootStyle}>
      <div style={styles.header}>
        <a style={styles.linkout} target="blank" href={"https://"+props.title}>
          <HexLogoTinyLong/>
        </a>
      </div>
      {props.children}
    </div>
  );
};

export default MaterialTitlePanelSidebar;
