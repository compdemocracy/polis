import React from "react";
import Awesome from "react-fontawesome";
import * as globals from "./framework/global-styles";
import Flex from "./framework/flex";

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
        <Flex justifyContent="space-between" alignItems="center">
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
          <Flex grow={1} justifyContent="flex-end" styleOverrides={{
              margin: 0, fontSize: 14, fontWeight: 300
            }}>
            <Awesome style={{marginRight: 7}} name="user"/>
            {props.name.split(" ")[0]}
          </Flex>
        </Flex>
      </div>
      {props.children}
    </div>
  );
};

export default MaterialTitlePanel;
