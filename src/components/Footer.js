import React from "react";
import * as globals from "./globals";
import LargeLogo from "./logoLargeShort";

const Footer = ({conversation}) => {
 return (
   <div style={{
       display: "flex",
       justifyContent: "center",
       marginTop: 40,
       marginBottom: 60,
     }}>
     <LargeLogo/>
   </div>
 )
};

export default Footer;
