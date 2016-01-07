import InputField from "material-ui/lib/text-field";
import React from "react";
import { connect } from "react-redux";
import { doSignin } from "../actions";
import Radium from "radium";

@connect()
@Radium
class SignIn extends React.Component {

  handleLoginClicked() {

    const attrs = {
      email: this.refs.email.value,
      password: this.refs.password.value
    }

    var dest = this.props.location.pathname.slice("/signin".length);

    this.props.dispatch(
      doSignin(attrs),
      dest);
  }

  render() {
    return (
      <div>
        <h1>Sign In</h1>
        <form>
          <input ref="email" type="text"/>
          <input ref="password" type="password"/>
          <button onClick={this.handleLoginClicked.bind(this)}>
            Sign In
          </button>
        </form>
      </div>
    );
  }
}

export default SignIn;
