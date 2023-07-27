import React, { useState, useEffect } from "react";
import Strings from "../strings/participation_en_us";
import PolisNet from "../util/net";
var _ = require("lodash");

const Visualization3 = ( {} ) => {
  useEffect(() => {
    console.log(Strings)
    buildPcaObject();
  }, []);

  const conversation_id = "7ajfd9j53y";
  let lastServerTokenForPCA = -1;

  const fetchPcaData = () => {
    return PolisNet.polisGet("/api/v3/math/pca2", {
      conversation_id: conversation_id,
      cacheBust: (Math.random() * 1e9 >> 0),
    }, {
      "If-None-Match": '"' + lastServerTokenForPCA + '"',
    });
  };

  const fetchFamousVotes = () => {
    return PolisNet.polisGet("/api/v3/votes/famous", {
      conversation_id: conversation_id,
      math_tick: lastServerTokenForPCA,
    })
  }

  const buildFamousVotesObject = () => {
    
  }

  const bucketize = () => {

  }

  const buildPcaObject = async () => {
    const pcaData = await fetchPcaData();
    console.log(pcaData)

    if (_.isNumber(pcaData.math_tick)) {
      lastServerTokenForPCA = pcaData.math_tick;
    } else {
      console.error("got invlid math_tick");
    }

    // create map for if a comment should not appear in visualization?
    let modOutTids = {};
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