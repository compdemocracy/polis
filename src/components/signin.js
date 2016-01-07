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
      username: this.refs.username.value,
      password: this.refs.password.value
    }

    this.props.dispatch(doSignin(attrs))
  }
  render() {
    return (
      <div>
        <h1>Sign In</h1>
        <form>
          <input ref="username" type="text"/>
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
