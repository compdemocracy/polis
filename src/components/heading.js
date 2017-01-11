import React from "react";
import * as globals from "./globals";

const Heading = ({conversation}) => {
  return (
    <p style={{fontSize: globals.primaryHeading}}> pol.is report {conversation ? conversation.conversation_id : "loading"} </p>
  );
};

export default Heading;
