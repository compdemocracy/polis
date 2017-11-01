
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
