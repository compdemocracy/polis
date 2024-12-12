// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.


import Checkbox from '../framework/checkbox.jsx';
import React from "react";
import settings from "../../settings";

const Controls = ({ onAutoRefreshEnabled, handleColorblindModeClick, colorBlindMode, onAutoRefreshDisabled, autoRefreshEnabled, voteColors}) => {

  const autoRefreshEnabledRef = React.createRef();
  const colorBlindModeRef = React.createRef();

  const checkboxGroupChanged = (newVal) => {
    if (newVal) {
      onAutoRefreshEnabled();
    } else {
      onAutoRefreshDisabled();
    }
  }

  return (
    <div>
    <Checkbox
      label= {"auto-refresh"}
      disabled={false}
      ref={autoRefreshEnabledRef}
      checked={ autoRefreshEnabled}
      clickHandler={checkboxGroupChanged}
      labelPosition={"left"}
      labelWrapperColor={settings.darkerGray}
      color={settings.polisBlue}/>
    <Checkbox
      label= {"color blind mode"}
      disabled={false}
      ref={colorBlindModeRef}
      checked={colorBlindMode}
      clickHandler={handleColorblindModeClick }
      labelPosition={"left"}
      labelWrapperColor={settings.darkerGray}
      color={settings.polisBlue}/>
    </div>
  );

}

export default Controls;
