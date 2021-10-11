// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from "react";
import _ from "lodash";
import CommentList from "./commentList";
import * as globals from "../globals";
import style from "../../util/style";

const Uncertainty = ({conversation, comments, ptptCount, uncertainty, formatTid, math, voteColors}) => {

  if (!conversation) {
    return <div>Cargando incertidumbre...</div>
  }
  return (
    <div>
      <p style={globals.primaryHeading}> Areas de incertidumbre </p>
      <p style={globals.paragraph}>
		Al cabo de {ptptCount} participantes, hay incertidumbre acerca de los siguientes enunciados. 
		Más del 30% de los participantes que vieron ese enunciado "pasaron".
      </p>
      <p style={globals.paragraph}>
        Las áreas de incertidumbre pueden indicar caminos para abrir el diálogo con tu comunidad. 
      </p>
      <div style={{marginTop: 50}}>
        <CommentList
          conversation={conversation}
          ptptCount={ptptCount}
          math={math}
          formatTid={formatTid}
          tidsToRender={uncertainty /* uncertainTids would be funnier */}
          comments={comments}
          voteColors={voteColors}/>
      </div>
    </div>
  );
};

export default Uncertainty;
