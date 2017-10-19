
import Checkbox from '../framework/checkbox';
import React from "react";
import settings from "../../settings";




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
      <Checkbox
        label= {"auto-refresh"}
        disabled={false}
        ref={"autoRefreshEnabled"}
        checked={ this.props.autoRefreshEnabled}
        clickHandler={ this.checkboxGroupChanged.bind(this) }
        labelPosition={"left"}
        labelWrapperColor={settings.darkerGray}
        color={settings.polisBlue}/>
    );
  }

};
        // <Checkbox value="pineapple"/>

export default Controls;
