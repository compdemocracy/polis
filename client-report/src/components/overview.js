// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import Radium from "radium";
import _ from "lodash";
import * as globals from "./globals";

const computeVoteTotal = (users) => {
  let voteTotal = 0;

  _.each(users, (count) => {
    voteTotal += count
  });

  return voteTotal;
}

const computeUniqueCommenters = (comments) => {

}

const Number = ({number, label}) => (
  <div style={{marginLeft: "10px", marginRight: "10px"}}>
    <p style={globals.overviewNumber}>
      {number.toLocaleString()}
    </p>
    <p style={globals.overviewLabel}>
      {label}
    </p>
  </div>
)

const Overview = ({
  conversation,
  demographics,
  ptptCount,
  ptptCountTotal,
  math,
  comments,
  //stats,
  computedStats,
}) => {
  return (
    <div >
      <p style={globals.primaryHeading}>Overview</p>
      <p style={globals.paragraph}>
        Pol.is es un sistema de encuestas en tiempo real que ayuda a identificar diferentes formas en que un grupo grande de personas piensa acerca de un tema complejo o divisorio. Aquí se muestra un desglose básico de algunos términos que se necesitan para entender este reporte.
      </p>
      <p style={globals.paragraph}>
        <strong>Participantes:</strong> Son las personas que participaron en la conversación, votando y escribiendo enunciados. Basados en cómo votaron, cada participante es clasificado en un grupo de opinión.
      </p>
      <p style={globals.paragraph}>
        <strong>Enunciados:</strong> Los participantes deberán añadir enunciados para que otros participantes voten.  Se asignará un número a cada enunciado a medida que sean añadidos. 
      </p>
      <p style={globals.paragraph}>
        <strong>Grupos de Opinión:</strong> Los grupos se forman con participantes que votaron en forma similar unos a otros, y en forma diferente a otros grupos. 
      </p>

      <p style={globals.paragraph}>
        {conversation && conversation.ownername ? "Esta conversación pol.is fue ejecutada por "+conversation.ownername+". " : null}
        {conversation && conversation.topic ? "El tema fue '"+conversation.topic+"'. " : null}
      </p>
      <div style={{maxWidth: 1200, display: "flex", justifyContent: "space-between"}}>
        <Number number={ptptCountTotal} label={"people voted"} />
        <Number number={ptptCount} label={"people grouped"} />

        <Number
          number={ computeVoteTotal(math["user-vote-counts"]) }
          label={"votes were cast"} />
        {/* Leaving this out for now until we get smarter conversationStats */}
        {/* <Number number={comments.length} label={"people submitted statements"} /> */}
        <Number number={math["n-cmts"]} label={"se enviaron enunciados"} />
        <Number number={computedStats.votesPerVoterAvg.toFixed(2)} label={"Promedio de votos por votante"} />
        <Number number={computedStats.commentsPerCommenterAvg.toFixed(2)} label={"Promedio de enunciados por autor"} />

      </div>

    </div>
  );
};

export default Overview;

// <p style={globals.paragraph}> {conversation && conversation.participant_count ? "A total of "+ptptCount+" people participated. " : null} </p>


// It was presented {conversation ? conversation.medium : "loading"} to an audience of {conversation ? conversation.audiences : "loading"}.
// The conversation was run for {conversation ? conversation.duration : "loading"}.
 // {demographics ? demographics.foo : "loading"} were women

 // {conversation && conversation.description ? "The specific question was '"+conversation.description+"'. ": null}
