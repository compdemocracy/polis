import React from "react";
import Radium from "radium";
import Awesome from "react-fontawesome";
import strings from "../../strings/strings";

const cardPadding = 10;
const cardBorderRadius = 3;

const styles = {
  card: {
    margin: "10px 20px 10px 20px",
    backgroundColor: "rgb(253,253,253)",
    borderRadius: 3,
    padding: "10px 10px",
    WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
    BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)"
  },
  notification: {
    fontSize: 16,
    fontWeight: 500,
    color: "rgb(160,160,160)"
  }
}

@Radium
class NoPermission extends React.Component {
  render() {
    return (
      <div style={styles.card}>
        <div style={styles.notification}>{strings("no_permission")}</div>
      </div>
    );
  }
}

export default NoPermission;
