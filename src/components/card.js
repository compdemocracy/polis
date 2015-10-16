import React from "react";

class Card extends React.Component {
  render() {
    return (
      <div>
        <p>{this.props.heading}</p>
        <p>{this.props.subheading}</p>
        {this.props.children}
      </div>
    );
  }
}

export default Card;