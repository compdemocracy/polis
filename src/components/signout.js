// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import { connect } from "react-redux";
import LanderContainer from "./App/Container/LanderContainer";
import ContainerInner from "./App/Container/ContainerInner";

import { doSignout } from "../actions";

@connect(state => state.signout)
class SignOut extends React.Component {

  componentWillMount () {
    var dest = this.props.location.pathname.slice("/signout".length);
    this.props.dispatch(doSignout(dest))
  }

  render() {
    return (
      <LanderContainer>
        <ContainerInner>
          <h1>Signing Out</h1>
        </ContainerInner>
      </LanderContainer>
    );
  }
}

export default SignOut;
