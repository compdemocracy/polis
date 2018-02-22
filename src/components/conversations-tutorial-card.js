// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from 'react';
import Radium from 'radium';
import Awesome from "react-fontawesome";

@Radium
class ConversationTutorialCard extends React.Component {
  constructor(props) {
    super(props);
    this.state = {

    };
  }
  static propTypes = {
    /* react */
    params: React.PropTypes.object,
    routes: React.PropTypes.array,
    /* component api */
    style: React.PropTypes.object,
    title: React.PropTypes.string,
    awesome: React.PropTypes.string,
    docs: React.PropTypes.bool,
    clickHandler: React.PropTypes.func,
  }
  static defaultProps = {
    title: "Default Tutorial Title",
    awesome: "plus",
    docs: false,
  }
  getStyles() {
    return {
      container: {
        maxWidth: 300,
        padding: 20,
        cursor: "pointer",
        margin: 20,
        color: "rgb(100,100,100)",
        backgroundColor: "rgb(253,253,253)",
        borderRadius: 3,
        WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
        BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)"
      },
      awesome: {
        marginRight: 10
      },
      heading: {
        fontWeight: 700
      },
      body: {
        fontWeight: 300,
        lineHeight: 1.7
      }

    };
  }
  render() {
    const styles = this.getStyles();
    return (
      <div
        onClick={this.props.clickHandler}
        style={[
          styles.container,
          this.props.style
        ]}>
        <p style={styles.heading}>
          <Awesome name={this.props.awesome} style={styles.awesome}/>
          {this.props.title}
        </p>
        <p style={styles.body}>
          {this.props.body}
        </p>
      </div>
    );
  }
}

export default ConversationTutorialCard;
