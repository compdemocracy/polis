import React, { useState, useEffect } from "react";
import Strings from "../strings/participation_en_us";
import PolisNet from "../util/net";

const Visualization3 = ( {} ) => {
  useEffect(() => {
    console.log(Strings)
    buildPcaObject();
  }, []);

  const conversation_id = "7ajfd9j53y";
  const lastServerTokenForPCA = -1;

  const fetchPcaData = (conv_id, timestamp) => {
    return PolisNet.polisGet("/api/v3/math/pca2", {
      conversation_id: conv_id,
      cacheBust: (Math.random() * 1e9 >> 0),
    }, {
      "If-None-Match": '"' + timestamp + '"',
    });
  };

  const buildPcaObject = async () => {
    const pcaData = await fetchPcaData(conversation_id, lastServerTokenForPCA);
    console.log(object)

    if (_.isNumber(pcaData.math_tick)) {
      lastServerTokenForPCA = pcaData.math_tick;
    } else {
      console.error("got invlid math_tick");
    }

    // create map for if a comment should not appear in visualization?
    modOutTids = {};
    var modOut = pcaData["mod-out"];
    if (modOut) {
      modOut.forEach(function(x) {
        modOutTids[x] = true;
      });
    }

  }
  

  return (
    <h1>Hello world</h1>
  )
}

export default Visualization3;