// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import { connect } from "react-redux";
import _ from "lodash";
import Highlight from "react-highlight";

@connect((state) => state.user)
class Integrate extends React.Component {
  render() {
    return (
      <div>
        <div>
          <p>Embed Code</p>
          <p>
            {`
              Copy and paste this code into your content management template.
              Each page (article, post) requires a unique string in the \"PAGE_ID\" field.
              This should be consistent over time and unique to
              each of your pages (like the article title).
            `}
          </p>
          <ul>
            <li>
              {`
                When this embed code loads on your website, it will either
                create a new conversation (if one is not already associated with
                the string passed into PAGE_ID) or load an existing conversation.
              `}
            </li>
            <li>
              {`
                This embed code will keep track of what conversations belongs on
                what pages via the data-page_id HTML attribute.
              `}
            </li>
            <li>
              {`
                Simply replace \"PAGE_ID\", either manually or in your templates,
                to create new conversations and load existing ones in the right place.
              `}
            </li>
            <li>
              {`Check out `}
              <a href="http://docs.pol.is" style={{ color: "black" }}>
                the docs
              </a>
              {` for advanced functionality, including per-user configuration,
                use with proprietary authorization, and eventing.`}
            </li>
          </ul>
          <div>
            <Highlight>
              {"<div\n"}
              {"  class='polis'\n"}
              {"  data-page_id='PAGE_ID'\n"}
              {"  data-site_id='"}
              {this.props.user === null
                ? "__loading, try refreshing__"
                : this.props.user.site_ids[0]}
              {"'>\n"}
              {"</div>\n"}
              {"<script async\n"}
              {"  src='https://pol.is/embed.js'>\n"}
              {"</script>"}
            </Highlight>
          </div>
        </div>
      </div>
    );
  }
}

export default Integrate;
