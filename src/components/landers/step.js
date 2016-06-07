import React from "react";
import Radium from "radium";
// import _ from "lodash";
import Flex from "../framework/flex";
// import { connect } from "react-redux";
// import { FOO } from "../actions";


// @connect(state => {
//   return state.FOO;
// })
@Radium
class Benefit extends React.Component {
  constructor(props) {
    super(props);
    this.state = {

    };
  }
  static propTypes = {
    /* react */
    // dispatch: React.PropTypes.func,
    params: React.PropTypes.object,
    routes: React.PropTypes.array,
    /* component api */
    style: React.PropTypes.object,
    // foo: React.PropTypes.string
  }
  static defaultProps = {
    // foo: "bar"
  }
  getStyles() {
    return {
      section: {
        padding: 0,
        width: "100%"
      },
      step: {
        marginBottom: 0,
        width: "100%",
      },
      stepText: {
        fontSize: "1.8em",
        margin: 0,
        backgroundColor: "#03a9f4",
        // color: "rgb(180,180,180)",
        color: "white",
        width: 36,
        padding: 10,
        height: 36,
        borderRadius: 100,
      },
      sectionBody: {
        maxWidth: 400,
        margin: "auto",
        padding: 20,
        fontSize: "1.2em",
        fontWeight: 300,
        lineHeight: 1.8,
        textAlign: "center"
      },
    };
  }
  render() {
    const styles = this.getStyles();
    return (
      <Flex
        styleOverrides={this.getStyles().section}
        direction="column"
        justifyContent="center"
        alignItems={"flex-start"}>
        <Flex justifyContent="center" styleOverrides={this.getStyles().step}>
          <p style={this.getStyles().stepText}>{this.props.step}</p>
        </Flex>
        <p style={this.getStyles().sectionBody}>
          {this.props.body}
        </p>
      </Flex>
    );
  }
}

export default Benefit;
