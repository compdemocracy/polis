import _ from "lodash";
import React from "react";
import * as globals from "./globals";

class Button extends React.Component {

  handleClick() {
    this.props.handleCurateButtonClick(this.props.identifier)
  }

  render () {

    return (
      <button style={{
        border: "none",
        fontSize: 14,
        marginRight: 5,
        cursor: "pointer",
        padding: "6px 12px",
        fontWeight: (!_.isNull(this.props.selectedTidCuration) && this.props.selectedTidCuration === this.props.identifier) ? 700 : 500,
        backgroundColor: (!_.isNull(this.props.selectedTidCuration) && this.props.selectedTidCuration === this.props.identifier) ? "#03a9f4" : "rgb(235,235,235)",
        color: (!_.isNull(this.props.selectedTidCuration) && this.props.selectedTidCuration === this.props.identifier) ? "rgb(255,255,255)" : "rgb(100,100,100)",
        borderRadius: 4,
      }}
      onClick={this.handleClick.bind(this)}>
        {this.props.children}
      </button>
    )
  }
}

class Curate extends React.Component {

  constructor(props) {
    super(props);

    this.state = {

    };
  }


  render () {
    return (
      <div style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "baseline",
        width: true ? "auto" : "100%",

      }}>
        <div style={{marginRight: 20}}>
          <Button
            selectedTidCuration={this.props.selectedTidCuration}
            handleCurateButtonClick={this.props.handleCurateButtonClick}
            identifier={globals.tidCuration.majority}>
            Majority Opinion
          </Button>
        </div>
        <div style={{
          display: "flex",
          justifyContent: "flex-start",
          alignItems: "baseline",
        }}>
          <p style={{
              marginRight: 10,
              fontSize: 14,
              fontFamily: "Georgia",
              fontStyle: "italic"
            }}>
            Group:
          </p>
          {
            _.map(this.props.math["group-votes"], (group) => {
              return (
                <Button
                  key={globals.groupLabels[group.id]}
                  handleCurateButtonClick={this.props.handleCurateButtonClick}
                  selectedTidCuration={this.props.selectedTidCuration}
                  identifier={group.id}>
                  {globals.groupLabels[group.id]}
                </Button>
              )
            })
          }
        </div>
      </div>
    )
  }
}


export default Curate;


// <div style={{marginRight: 20}}>
//   <Button
//     selectedTidCuration={this.props.selectedTidCuration}
//     handleCurateButtonClick={this.props.handleCurateButtonClick}
//     identifier={globals.tidCuration.differences}>
//     Differences
//   </Button>
// </div>
