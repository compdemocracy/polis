/** @jsx jsx */
import { Component } from "react";
import { Flex, Box, Link } from "theme-ui";
import { jsx } from "theme-ui";
// import logo from "../logo.svg"

class Header extends Component {
  constructor(props) {
    super(props);
    // this.state = { expanded: false }
    this.toggle = this.toggle.bind(this);
  }

  toggle() {
    // this.setState(state => ({
    //   expanded: !state.expanded,
    // }))
  }

  render() {
    // const { expanded } = this.state

    return (
      <Box>
        <Flex
          sx={{
            margin: `0 auto`,
            width: "100%",
            maxWidth: this.props.globalWidth,
            paddingTop: "2rem",
            paddingBottom: "1.45rem",
            paddingLeft: "1.0875rem",
            paddingRight: " 1.0875rem",
            justifyContent: "space-between",
          }}
        >
          <Box sx={{ zIndex: 1000 }}>
            <Link sx={{ variant: "links.nav" }} to="/">
              <svg
                width="20"
                viewBox="0 0 88 100"
                style={{ marginRight: 10, position: "relative", top: 6 }}
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path d="M44 0L87.3013 25V75L44 100L0.69873 75V25L44 0Z" fill="#03A9F4" />
              </svg>
              Polis
            </Link>
          </Box>
          {/* <Box
            sx={{
              display: ["inherit", "none", "none"],
              zIndex: 1000,
              position: "fixed",
              top: "26px",
              right: "20px",
              backgroundColor: "white",
            }}
          >
            <MenuButton onClick={this.toggle} aria-label="Toggle Menu" />
          </Box>
          <Box sx={{ display: ["none", "inherit", "inherit"] }}>
            <GatsbyLink sx={{ variant: "links.nav", mr: [3] }} to="/team">
              Team
            </GatsbyLink>

            <GatsbyLink sx={{ variant: "links.nav", mr: [3] }} to="/faq">
              FAQ
            </GatsbyLink>
          </Box> */}
          <Box>
            <Link href="/signin">Sign in</Link>
          </Box>
        </Flex>
        {/* {expanded && (
          <div
            onClick={this.toggle}
            sx={{
              position: "absolute",
              right: [3],
              position: "fixed",
              top: "0px",
              width: "100%",
              height: "100%",
              background: "rgb(255,255,255,0.95)",
              textAlign: "right",
            }}
          >
            <GatsbyLink
              sx={{
                variant: "links.nav",
                fontSize: [4],
                display: "block",
                mr: "8px",
                mt: "70px",
              }}
              to="/about"
            >
              Our plan
            </GatsbyLink>
            <GatsbyLink
              sx={{
                variant: "links.nav",
                fontSize: [4],
                display: "block",
                mr: "8px",
              }}
              to="/team"
            >
              Our team
            </GatsbyLink>
            <GatsbyLink
              sx={{
                variant: "links.nav",
                fontSize: [4],
                display: "block",
                mr: "8px",
              }}
              to="/resources"
            >
              Resources
            </GatsbyLink>
            <GatsbyLink
              sx={{
                variant: "links.nav",
                fontSize: [4],
                display: "block",
                mr: "8px",
              }}
              to="/faq"
            >
              FAQ
            </GatsbyLink>
            <GatsbyLink
              sx={{
                variant: "links.nav",
                fontSize: [4],
                display: "block",
                mr: "8px",
              }}
              to="/contact"
            >
              Contact
            </GatsbyLink>
          </div>
        )} */}
      </Box>
    );
  }
}

export default Header;
