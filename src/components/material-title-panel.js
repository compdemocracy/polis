import React from "react";
import Awesome from "react-fontawesome";
import * as globals from "./framework/global-styles";

const styles = {
  root: {
    height: "100%"
  },
  header: {
    backgroundColor: "#03a9f4",
    color: "white",
    padding: "16px",
    fontSize: "1.5em",
    // position: "fixed",
    // width: "100%",
    minHeight: globals.headerHeight,
  },
};

const MaterialTitlePanel = (props) => {

  const rootStyle = props.style ? {...styles.root, ...props.style} : styles.root;
  return (
    <div style={rootStyle}>
      <div style={styles.header}>
        {
          props.showHamburger ?
            "" :
            <div
              onClick={props.handleHamburgerClick}
              style={{
                marginRight: 15,
                display: "inline",
                fontSize: 18,
                cursor: "pointer"
              }}>
              <Awesome name="bars"/>
            </div>
        }
        { props.title }
      </div>
      {props.children}
    </div>
  );
};

export default MaterialTitlePanel;
