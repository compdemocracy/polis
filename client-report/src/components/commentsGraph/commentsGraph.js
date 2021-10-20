// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import _ from "lodash";
import * as globals from "../globals";
import graphUtil from "../../util/graphUtil";
import Axes from "../graphAxes";
// import Participants from "./graphParticipants";
// import Hull from "./hull";
import Comments from "./comments";

const TextSegment = ({t, i}) => <tspan x="27" y={i * 14}>{t}</tspan>

class CommentsGraph extends React.Component {

  constructor(props) {
    super(props);
    this.Viewer = null;
    this.state = {
      selectedComment: null,
    };
  }

  handleCommentClick(selectedComment) {
    return () => {
      this.setState({selectedComment});
    }
  }

  render() {

    if (!this.props.math) {
      return null;
    }

    const {
      xx,
      yy,
      commentsPoints,
      xCenter,
      yCenter,
      baseClustersScaled,
      commentScaleupFactorX,
      commentScaleupFactorY,
      hulls,
    } = graphUtil(this.props.comments, this.props.math, this.props.badTids);

    return (
      <div style={{position: "relative"}}>
        <div>
          <p style={globals.primaryHeading}> Enunciados </p>
          <p style={globals.paragraph}>
          ¿Cómo se relacionan entre sí los enunciados? ¿Las personas que estuvieron de acuerdo en un enunciado también están de acuerdo con otro?
		  </p>
          <p style={globals.paragraph}>
          En este gráfico los enunciados que produjeron desacuerdos se encuentran más relacionados si fueron votados en forma similar.
		  Los enunciados que fueron votados en forma diferente se encuentran apartados entre sí.
		  </p>
          <p style={Object.assign({}, globals.paragraph, {fontStyle: "italic"})}>
          Esto es importante porque es la base en la cual trazaremos y agruparemos a los participantes en pasos siguientes (más cercanos a los enunciados en los cuales estuvieron de acuerdo). No hay ejes significativos pero hay áreas de enunciados que otorgan cierta personalidad a un área dada.
          </p>
        </div>
        <p style={{fontWeight: 500, maxWidth: 600, lineHeight: 1.4, minHeight: 50}}>
          {
            this.state.selectedComment ?
            "#" + this.state.selectedComment.tid + ". " + this.state.selectedComment.txt :
            "Click en un enunciado, identificado por su número, para explorar las regiones del gráfico"
          }
        </p>
          <svg
            style={{
              border: "1px solid rgb(180,180,180)",
            }}
            width={this.props.height ? this.props.height : globals.side}
            height={this.props.height ? this.props.height : globals.side}>
            {/* Comment https://bl.ocks.org/mbostock/7555321 */}
            <g transform={`translate(${globals.side / 2}, ${15})`}>
              <text
                style={{
                  fontFamily: "Georgia",
                  fontSize: 14,
                  fontStyle: "italic"
                }}
                textAnchor="middle">

              </text>
            </g>
            <Axes xCenter={xCenter} yCenter={yCenter} report={this.props.report}/>
            // {/*<Participants points={baseClustersScaled}/>*/}
            {/* this.props.math["group-clusters"].map((cluster, i) => {
              return (<text x={300} y={300}> Renzi Supporters </text>)
            }) : null */}
            {/*
              hulls.map((hull) => {
                let gid = hull.group[0].gid;
                if (_.isNumber(this.props.showOnlyGroup)) {
                  if (gid !== this.props.showOnlyGroup) {
                    return "";
                  }
                }
                return <Hull key={gid} hull={hull}/>
              })
            */}
            {
              commentsPoints ?
              <Comments
                {...this.props}
                handleClick={this.handleCommentClick.bind(this)}
                points={commentsPoints}
                xx={xx}
                yy={yy}
                xCenter={xCenter}
                yCenter={yCenter}
                xScaleup={commentScaleupFactorX}
                yScaleup={commentScaleupFactorY}/> :
              null
            }
          </svg>

      </div>
    );
  }
}

export default CommentsGraph;
