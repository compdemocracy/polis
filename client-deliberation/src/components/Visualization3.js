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
    const object = await fetchPcaData(conversation_id, lastServerTokenForPCA);
    console.log(object)
  }

  

  return (
    <h1>Hello world</h1>
  )
}

export default Visualization3;