import React from "react";
import { connect } from "react-redux";
import { populateUserStore } from '../actions'
import Radium from "radium";
import _ from "lodash";
import {Link} from "react-router";
import Spinner from "./framework/spinner";
import Awesome from "react-fontawesome";

import Sidebar from "react-sidebar";

@connect(state => state.user)
@Radium
class App extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      sidebarOpen: false,
      sidebarDocked: true,
    };
  }

  loadUserData() {
    this.props.dispatch(populateUserStore())
  }

  componentWillMount () {
    this.loadUserData()
    var mql = window.matchMedia(`(min-width: 800px)`);
    mql.addListener(this.mediaQueryChanged.bind(this));
    this.setState({mql: mql, docked: mql.matches});
  }

  componentWillUnmount () {
    this.state.mql.removeListener(this.mediaQueryChanged.bind(this));
  }

  mediaQueryChanged () {
    this.setState({sidebarDocked: this.state.mql.matches});
  }

  onSetSidebarOpen (open) {
    this.setState({sidebarOpen: open});
  }

  handleMenuButtonClick () {
    this.setState({sidebarOpen: !this.state.sidebarOpen})
  }

  addHamburger() {
    return (
      <div
        onClick={this.handleMenuButtonClick.bind(this)}
        style={{marginRight: 15, display: "inline"}}>
        <Awesome name="bars" style={{fontSize: 24, cursor: "pointer"}}/>
      </div>
    )
  }

  render() {
    const homeSidebarContent = (
      <div style={{marginLeft: 10}}>
        <h3 style={{marginRight: 10}}><Link to="/"> Polis Home </Link></h3>
        <div> {this.props.user ? this.props.user.hname : <Spinner/>} </div>
        <p><Link style={{marginRight: 15}} to="/new">New</Link></p>
        <p><Link style={{marginRight: 15}} to="/integrate">Integrate</Link></p>
        <p><Link style={{marginRight: 15}} to="/conversations">Conversations</Link></p>
        <p><Link style={{marginRight: 15}} to="/overall-stats">Overall Stats</Link></p>
        <p><Link style={{marginRight: 15}} to="/account">Account</Link></p>
        <p> -------- </p>
        <p><a style={{marginRight: 15}} href="http://docs.pol.is">Docs</a></p>
        <p><a style={{marginRight: 15}} href="https://twitter.com/UsePolis">@UsePolis</a></p>
      </div>
    )
    const conversationSidebarContent = (
      <div style={{marginLeft: 10}}>
        <p>
          <Link to="/">
            <Awesome name="chevron-left" style={{fontSize: 24, cursor: "pointer"}}/>
            <Awesome name="home" style={{fontSize: 24, cursor: "pointer"}}/>
          </Link>
        </p>
        <h3 style={{marginRight: 10}}> Conversation Admin </h3>
        <p> <em> pol.is/55555 </em> </p>
        <p>
          <Link
            style={{marginRight: 15}}
            to={"/m/"+this.props.params.conversation+"/share"}>
            Share & Embed
          </Link>
        </p>
        <p>
          <Link
            style={{marginRight: 15}}
            to={"/m/"+this.props.params.conversation+"/stats"}>
            Stats
          </Link>
        </p>
        <p>
          <Link
            style={{marginRight: 15}}
            to={"/m/"+this.props.params.conversation+"/config"}>
            Config
          </Link>
        </p>
        <p>
          <Link
            style={{marginRight: 15}}
            to={"/m/"+this.props.params.conversation+"/comments"}>
            Comments
          </Link>
        </p>
        <p>
          <Link
            style={{marginRight: 15}}
            to={"/m/"+this.props.params.conversation+"/participants"}>
            Participants
          </Link>
        </p>
        <p>
          <Link
            style={{marginRight: 15}}
            to={"/m/"+this.props.params.conversation+"/conversation"}>
            iFrame of Conversation</Link></p>
        <p> -------- </p>
        <p><a style={{marginRight: 15}} href="http://about.pol.is">Docs</a></p>
        <p><a style={{marginRight: 15}} href="https://twitter.com/UsePolis">@UsePolis</a></p>
      </div>
    )
    return (
      <Sidebar
        sidebar={
          this.props.params.conversation ?
            conversationSidebarContent : homeSidebarContent
        }
        open={this.state.sidebarOpen}
        docked={this.state.sidebarDocked}
        onSetOpen={this.onSetSidebarOpen.bind(this)}>
        <div style={{width: 800, margin: 40}}>
          {
            /* this.state.sidebarOpen ? "" : */
            this.addHamburger()
          }
          {this.props.children}
        </div>
      </Sidebar>

    );
  }
}

const styles = {
  sidebarItem: {
    marginRight: 15,
    color: "darkgrey",
    backgroundColor: "white"
  }
};

export default App;
