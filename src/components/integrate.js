import React from "react";
import { connect } from "react-redux";
import Radium from "radium";
import _ from "lodash";
import Highlight from "react-highlight";
import MaterialTitlePanel from './material-title-panel';

const styles = {
  card: {
    margin: "10px 20px 10px 20px",
    backgroundColor: "rgb(253,253,253)",
    borderRadius: 3,
    padding: 10,
    WebkitBoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)",
    BoxShadow: "3px 3px 6px -1px rgba(220,220,220,1)"
  },
}

@connect(state => state.user)
@Radium
class Integrate extends React.Component {
  render() {
    return (
      <div style={styles.card}>
        <p style={{ userSelect: "none"}}>
          {
            "Want to integrate polis into your site as a comment system? You're in the right place! Copy and paste this code into the template for your pages. The only thing you have to do is replace \"PAGE_ID\" with a unique string on each of your pages."
          }
        </p>
        <ul style={{ userSelect: "none"}}>
          <li>
            {
              "When this embed code loads on your website, it will either create a new conversation (if one is not already associated with the string passed into PAGE_ID) or load an existing conversation."
            }
          </li>
          <li>
            {
              "This embed code will keep track of what conversations belongs on what pages via the data-page_id HTML attribute."
            }
          </li>
          <li>
            {
              "Simply replace \"PAGE_ID\", either manually or in your templates, to create new conversations and load existing ones in the right place."
            }
          </li>
        </ul>
        <div style={{
          backgroundColor: "rgb(240,240,240)",
          padding: "10px 20px",
          borderRadius: 3
        }}>
          <Highlight>
            {"<div\n"}
            {"  class='polis'\n"}
            {"  data-page_id='PAGE_ID'\n"}
            {"  data-site_id='"}
            {this.props.user === null ? "__loading, try refreshing__" : this.props.user.site_ids[0]}
            {"'>\n"}
            {"</div>\n"}
            {"<script async='true' src='https://pol.is/embed.js'></script>"}
          </Highlight>
        </div>
      </div>
    );
  }
}

export default Integrate;

