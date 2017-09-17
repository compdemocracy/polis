import React from "react";
import * as globals from "../globals";
import SmallLogo from "./logoSmallLong";

const Content = ({conversation}) => {
  return (
    <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-end",
        width: "100%",
        paddingBottom: 5,
        borderBottom: "1px solid rgb(130,130,130)",
      }}>
      <SmallLogo/>
      <p style={{
          fontSize: 36,
          margin: 0,
        }}>
        Report
      </p>
      <p style={{
          fontSize: 24,
          margin: 0,
        }}>
        <a
          style={{color: "#03A9F4", fontWeight: 700, textDecoration: "none"}}
          href={`https://pol.is/${conversation.conversation_id}`}>pol.is/{conversation.conversation_id}
        </a>
      </p>
    </div>
  );
}

const Heading = ({conversation}) => {
 return (
   <div>
     {conversation ? <Content conversation={conversation}/> : "Loading..."}
   </div>
 )
};

export default Heading;
