import React from "react";
import * as globals from "./globals";

const Heading = ({conversation}) => {
  return (
    <p style={{fontSize: globals.primaryHeading}}>
      {conversation ? "Report for conversation "+conversation.conversation_id : "loading"} 
    </p>
  );
};

export default Heading;
