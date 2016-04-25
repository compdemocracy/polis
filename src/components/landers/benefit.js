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
        margin: 20
      },
      sectionHeader: {
        fontSize: 24,
        marginBottom: 0,
      },
      sectionBody: {
        maxWidth: 400,
        fontWeight: 300,
        lineHeight: 1.5
      },
    };
  }
  render() {
    const styles = this.getStyles();
    return (
      <Flex
        styleOverrides={this.getStyles().section}

        direction="column"
        alignItems={"flex-start"}>
        <p style={this.getStyles().sectionHeader}>
          {this.props.heading}
        </p>
        <p style={this.getStyles().sectionBody}>
          {this.props.body}
        </p>
      </Flex>
    );
  }
}

export default Benefit;
