// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import { browserHistory } from "react-router";
import { connect } from "react-redux";

import PolisNet from "../../util/net";
import strings from "../../strings/strings";
import { doSignin, doFacebookSignin } from "../../actions";

import CTA from "./CTA/CTA";
import Nav from "../App/Nav/Nav";
import FeatureSection from "./Features/FeatureSection";
import Footer from "../App/Footer/Footer";
import FooterData from '../../strings/footer'
import Hero from "./Hero/Hero";
import Trust from "./Trust/Trust";

@connect()
class Home extends React.Component {
  render() {
    return <main>
        <Nav />
        <Hero headline="Know what your organization is thinking" subheadline="Polis helps organizations understand themselves. Get a summary visualization of all the viewpoints to move a conversation forward." className="page-header mt6 mt5-ns" />
        <Trust headline="You’re in good company" subheadline="Polis is trusted by governments, universities, non-profits, movements, and large organizations." />
        <FeatureSection />
        <CTA /> 
        <Footer social={FooterData.footer.social} content={FooterData.footer.groups} data={FooterData.footer} />
      </main>;
  }
}

export default Home;
