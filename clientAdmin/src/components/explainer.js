// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";

const s = {};

s.container = {
  marginTop: 20,
  padding: "0px 15px 15px 15px",
  maxWidth: 600,
  borderTop: "1px solid lightgrey",
}

s.section = {
  marginBottom: 30,
}

s.heading = {
  fontWeight: 500,
  fontSize: 16,
  textTransform: "uppercase",
  color: "rgb(80,80,80)",
}

s.body = {
  // fontFamily: "Georgia",
  fontSize: 16,
  // borderLeft: "7px solid rgb(150,150,150)",
  color: "rgb(150,150,150)",
  // padding: "0px 10px",
  lineHeight: "1.65em",
}

s.link = {
  color: "#03a9f4",
}

s.image = {
  width: "100%",
}

s.callOut = {
  // fontWeight: 700,
  // fontStyle: "italic",
  // color: "rgb(100,100,100)",
}

class Explainer extends React.Component {


  render() {
    return (
      <div style={s.container}>
        <p style={{fontSize: 36, textAlign: "center"}}>pol.is in 1 minute</p>
        <div style={s.section}>
          <p style={s.heading}>What you do</p>
          <p style={s.body}>
            pol.is is a new kind of survey that participants create as they go. Your job is to create and invite people to conversations. Pol.is automatically finds patterns and produces insights, then delivers a report that you can share with your community.
          </p>
        </div>
        <div style={s.section}>
          <p style={s.heading}>1: Ask</p>
          <p style={s.body}>
            Prompt your community with a question. Pick a topic that matters—complicated topics are perfect. Pol.is is built for complex, large-scale conversations with lots of stakeholders. Your role is to ask your community a question or give them a prompt (like an article or a tweet). Each person in your community votes on statements submitted by others, and can submit statements of their own. 
          </p>
        </div>
        <div style={s.section}>
          <p style={s.heading}>2: Customize</p>
          <p style={s.body}>
            Pol.is has a bunch of settings you can use to customize your conversations. Is participation anonymous? Will you moderate comments? Can everyone see how others voted? Choose the options that work best for your conversation, and message us if you need help!
          </p>
        </div>
        <div style={s.section}>
          <p style={s.heading}>3: Add Comments</p>
          <p style={s.body}>
            Add comments so your first participants have something to vote on when they arrive at your conversation. Add about 5-15 initial comments that represent as many perspectives as you can think of. 
          </p>
        </div>
        <div style={s.section}>
          <p style={s.heading}>4: Share</p>
          <p style={s.body}>
            Finally, share a link to your conversation to invite participants. You can leave the conversation on Pol.is or embed it as a widget on your website. Invite lots of people! The results start getting really interesting after about 30 people have voted on 30 comments each.
          </p>
        </div>
    </div>
    );
  }
}
    /*
        <div style={s.section}>
          <p style={s.heading}>What your community does</p>
          <p style={s.body}>
            Each person in your community votes on statements submitted by others, and optionally submits statements of their own. On average, 10 people will vote for each person who submits a statement, and each voter typically votes on around 40 statements. This has a moderating influence on those passionate enough to share their thoughts - it becomes clear what statements represent the silent majority.
          </p>
          <img style={s.image} src="https://s2.postimg.org/5rrcu0zvd/what_Your_Community_Does.jpg"/>
        </div>
        <div style={s.section}>
          <p style={s.heading}>What the visualization shows</p>
          <p style={s.body}>
            Unless you choose to disable the visualization, each participant will see his or her position move towards those who voted like they did. They’ll be able to click on opinion groups and see what voting patterns set them apart, and where common ground exists. They’ll discover whether they’re in the majority or minority, and be surprised by what they share with perceived opponents. As everyone votes, the visualization will update in real time.
          </p>
          <img style={s.image} src="https://s1.postimg.org/xku3llohb/what_The_Visualization_Shows.jpg"/>
        </div>
        <div style={s.section}>
          <p style={s.heading}>What you get</p>
          <p style={s.body}>
            We’ll give you a real-time, beautiful report that summarizes the insights our algorithms have generated. We’ll show you consensus, opinion groups, and details about areas of uncertainty. We are constantly working to bring new insights to the report. <a style={s.link} target="_blank" href="https://pol.is/report/r8zjztmxvc5x82pwer6my"> See a report from an open conversation run by New Zealand publisher Scoop on the topic of Affordable Housing. </a>
          </p>
        </div>
        <div style={s.section}>
          <p style={s.heading}>What you pay</p>
          <p style={s.body}>
            If you just need pol.is for yourself in your organization, a pro account is $250 per month flat. If you want to power up software you’re building, or need an on premises installation for security reasons, get in touch inside the app and let us know! <a target="_blank" href="https://pol.is/pricing" style={s.link}> Check out pricing & plans.</a>
          </p>
        </div>
        <div style={s.section}>
          <p style={s.heading}>What you do next</p>
          <p style={s.body}>
            Pol.is can plug into decision making systems which already exist, or power up new ones. Check out our blog for case studies to see what others have done!
          </p>
        </div>
      </div>
      */

export default Explainer;
