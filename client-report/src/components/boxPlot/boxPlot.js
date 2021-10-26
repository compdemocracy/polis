// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import _ from "lodash";
import * as globals from "../globals";
import drawBoxPlot from "./drawBoxPlot";

class BoxPlot extends React.Component {

  componentDidMount() {
    drawBoxPlot(this.createBoxplotDataset());
  }

  createBoxplotDataset() {
    const dataset = [];
    _.each(this.props.groupVotes, (g, ii) => {      /* for each comment each group voted on ... */
      dataset[ii] = [];                             /* initialize empty array which will have two entries: label and array of votes */
      dataset[ii][0] = globals.groupLabels[g.id]    /* g.id = 0, so go get "A" for the label */
      dataset[ii][1] = [];
      _.forEach(g.votes, (v) => {      /* extract agrees as percent */
        if (v["S"] > 0) {                           /* make sure someone saw it */
          dataset[ii][1].push(Math.floor(v["A"] / v["S"] * 100))  /* agreed / saw ... so perhaps 5 agreed / 10 saw for 50% */
        }
      });
    });
    return dataset;
  }

  render() {
    return (
      <div>
        <p style={globals.primaryHeading}>Promedio de nivel de acuerdo por grupo</p>
        <p style={globals.paragraph}>
          ¿Qué grupo estuvo más de acuerdo en todos los enunciados?
		  La linea en el medio del recuadro azul abajo muestra el porcentaje promedio de acuerdo en un grupo dado a los largo de todos los enunciados. 
		  Cuanto más baja se encuentre la línea en el medio del recuadro azul, más desacuerdo hubo en el grupo. Cuando más alta se encuentre la línea, más acuerdo hubo en el grupo
        </p>
        <p style={globals.paragraph}>
          Si el promedio y el recuadro coloreado son altos significa que la gente en el grupo estuvo de acuerdo en todo.
		  Esto sugeriría que sus puntos de vista están representados. 
        </p>
        <p style={globals.paragraph}>
          Si el recuadro coloreado está más bajo significa que el grupo en promedio estuvo en desacuerdo en la mayoría de los enunciados.
          Un grupo con un promedio más bajo de acuerdos puede ser un grupo que necesite comentar más, para que sus puntos de vista estén adecuadamente representados.
        </p>
        <p style={globals.paragraph}>
          <a target="_blank" href="https://www.khanacademy.org/math/probability/data-distributions-a1/box--whisker-plots-a1/v/reading-box-and-whisker-plots">
          How to read a box plot
          </a> (3 minute video).</p>
        <div id="boxPlot"> </div>
      </div>
    );
  }
}

export default BoxPlot;
