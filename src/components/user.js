import React from "react";
import { connect } from "react-redux";
import Card from "./card";

// @connect(state => state.userData)
class User extends React.Component {
  createCards() {
    // replace with this.state.data.map
    const cards = [{a: "Foo", b: "FooSub"}, {a: "Bar", b: "FooSub"}].map((obj) => {
      return (
        <div>
          <Card
            heading={obj.a}
            subheading={obj.b}>
            <p> i am a child </p>
          </Card>
        </div>
      )
    })
    return cards;
  }
  render() {
    return (
      <div>
        <h1>Users</h1>
        {this.createCards()}
      </div>
    );
  }
}

export default User;