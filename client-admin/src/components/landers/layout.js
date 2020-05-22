import React from "react";
import Header from "./header";
// import Footer from "./footer"
import { Box } from "theme-ui";

const Layout = ({ children }) => {
  const globalWidth = "45em";
  return (
    <Box>
      <Header globalWidth={globalWidth} />
      <Box
        sx={{
          margin: `0 auto`,
          maxWidth: globalWidth,
          padding: `0 1.0875rem 1.45rem`,
        }}
      >
        {children}
      </Box>
      {/* <Footer /> */}
    </Box>
  );
};

export default Layout;
