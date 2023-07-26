import React, { useState, useEffect } from "react";
var Strings = require("../strings/participation_en_us");
import Root from "../vis2/vis2";

const Visualization2 = () => {
  useEffect(() => {
    // routes we need to call
    // comments
    // pca2
    // votes
  });

  function getFancyComments() {

  }

  // renderVis parameters
  // Strings: copy file from client-participation?
  // math_main: cachedPcaData, comes from pca2 route but can be null?
  // comments: comes from getFancyComments()
  // tidsToShow: tid == comment id, set to an empty array
  // ptptios: calls getParticipantsOfInterestIncludingSelf()
  // votesByMe: calls getVotesByMe()
  // onVoteClicked: not sure exactly what this is for??
  // onCurationChange: look at client-participation/js/views/participation.js:379

  return (
    <Root
      comments={getFancyComments()}
      math_main={}
      tidsToShow={}
      ptptois={}
      votesByMe={}
      onVoteClicked={}
      onCurationChange={}
      Strings={Strings}
    />
  );
};

export default Visualization2;
