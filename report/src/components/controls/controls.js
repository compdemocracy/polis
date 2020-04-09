// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.


import Checkbox from '../framework/checkbox';
import React from "react";
import settings from "../../settings";
import * as globals from "../globals";

class Controls extends React.Component {

  constructor(props) {
    super(props);

  }

  checkboxGroupChanged(newVal) {
    if (newVal) {
      this.props.onAutoRefreshEnabled();
    } else {
      this.props.onAutoRefreshDisabled();
    }
  }

  componentWillMount() {
  }

  render() {
    return (
      <div>
      <Checkbox
        label= {"auto-refresh"}
        disabled={false}
        ref={"autoRefreshEnabled"}
        checked={ this.props.autoRefreshEnabled}
        clickHandler={ this.checkboxGroupChanged.bind(this) }
        labelPosition={"left"}
        labelWrapperColor={settings.darkerGray}
        color={settings.polisBlue}/>
      <Checkbox
        label= {"color blind mode"}
        disabled={false}
        ref={"colorBlindMode"}
        checked={ this.props.colorBlindMode}
        clickHandler={ this.props.handleColorblindModeClick }
        labelPosition={"left"}
        labelWrapperColor={settings.darkerGray}
        color={settings.polisBlue}/>
      </div>
    );
  }

};
        // <Checkbox value="pineapple"/>

export default Controls;
