import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import $ from "jquery";

@connect(state => state.data)
@Radium
class Inbox extends React.Component {
  componentDidMount() {

    $.get('/api/v3/conversations?limit=100').then(function(response) {
      console.dir(response);
    });

    // › eval `bin/herokuConfigExport`

    //   in server/ on master
    // › export PORT=5001

    // to port code over, look at the requests and see what they do in the network pane

    // didn't send up cookies? jquery does automatically... token2 is what we need https://www.dropbox.com/s/x36uokxv79qpngi/Screenshot%202015-11-08%2000.37.23.png?dl=0

    // fetch('/api/v3/conversations?limit=100')
    //   .then(function(response) {
    //     return response.json()
    //   }).then(function(json) {
    //     console.log('parsed json', json)
    //   }).catch(function(ex) {
    //     console.log('parsing failed', ex)
    //   })
  }
  render() {
    return (
      <div>
        <h1>Inbox</h1>
        <div>
          "Inbox"
        </div>
      </div>
    );
  }
}

export default Inbox;