import React from "react";
import DOM from "react-dom";

class App extends React.Component {
  render() {
    return (
      <h1>It Works!</h1>
    )
  }
}

DOM.render(<App/>, document.getElementById('root'));
