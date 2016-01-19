import React from "react";
import Radium from "radium";
import _ from "lodash";
import Flex from "./flex";

@Radium
class PolisLogo extends React.Component {

  render() {
    return (
      <Flex align="center">
        <div style={{
          width: 15,
          height: 15,
          marginRight: 6,
          borderRadius: 20,
          backgroundColor: "rgba(255,255,255,1)"}}>
        </div>
        <div style={{
          width: 20,
          height: 20,
          marginRight: 6,
          borderRadius: 20,
          backgroundColor: "rgba(255,255,255,1)"}}>
        </div>
        <div style={{
          width: 10,
          height: 10,
          marginRight: 6,
          borderRadius: 20,
          backgroundColor: "rgba(255,255,255,1)"}}>
        </div>
        <p>
          POLIS
        </p>
      </Flex>
    );
  }
}

export default PolisLogo;



