import React from "react";
import Radium from "radium";
// import _ from "lodash";
// import Flex from "./framework/flex";
import {Link} from "react-router";
import Awesome from "react-fontawesome";

@Radium
class SidebarItem extends React.Component {
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
    selected: false,
    to: React.PropTypes.string,
    icon: React.PropTypes.string
  }
  static defaultProps = {
    // foo: "bar"
  }
  getStyles() {
    return {
      base: {
        display: "block",
        padding: "16px 0px 16px 16px",
        color: this.props.selected ? "white" : "#757575",
        backgroundColor: this.props.selected ? "#03a9f4" : "white",
        textDecoration: "none",
        cursor: "pointer"
      }
    };
  }
  render() {
    const styles = this.getStyles();
    return (
      <Link
        to={this.props.to}
        style={styles.base}>
        <Awesome style={{marginRight: 10}} name={this.props.icon}/>
        {` `}
        {this.props.text}
      </Link>
    );
  }
}

export default SidebarItem;
