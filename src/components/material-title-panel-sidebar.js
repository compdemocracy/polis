import React from "react";
import Awesome from "react-fontawesome";
import * as globals from "./framework/global-styles";
import HexLogoTinyShort from "./framework/hex-logo-tiny-short";

const styles = {
  root: {
    fontFamily: '"HelveticaNeue-Light", "Helvetica Neue Light", "Helvetica Neue", Helvetica, Arial, "Lucida Grande", sans-serif',
    fontWeight: 300,
  },
  header: {
    backgroundColor: "#03a9f4",
    color: "white",
    fontSize: "1.5em",
    paddingTop: 8,
    display: "flex",
    justifyContent: "center",
    paddingBottom: 2,
  },
  linkout: {
  }
};

const MaterialTitlePanelSidebar = (props) => {

  const rootStyle = props.style ? {...styles.root, ...props.style} : styles.root;
  return (
    <div style={rootStyle}>
      <div id="76876876" style={styles.header}>
        <a style={styles.linkout} target="blank" href={"https://"+props.title}>
            <HexLogoTinyShort/>
        </a>
      </div>
      {props.children}
    </div>
  );
};

export default MaterialTitlePanelSidebar;
