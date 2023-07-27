import React, { useState, useEffect } from "react";
import Strings from "../strings/participation_en_us";
import PolisNet from "../util/net";
import anon_profile from "./anon_profile";
var _ = require("lodash");

const Visualization3 = ( {} ) => {
  useEffect(() => {
    console.log(Strings)
    buildPcaObject();
  }, []);

  const conversation_id = "7ajfd9j53y";
  let lastServerTokenForPCA = -1;
  let participantsOfInterestVotes = null; // change this global variable to a parameter at some point
  let participantsOfInterestBids = [];  // change this global variable to a parameter at some point


  // normally this would be passed in via props, but since this is being
  // developed as an isolated component, we will call the API for it again here
  const getMyPid = () => {
    return PolisNet.polisGet("/api/v3/participationInit", {
      conversation_id: conversation_id,
      pid: "mypid",
      lang: "acceptLang",
    });
  }

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

  const buildFamousVotesObject = async () => {
    const myPid = await getMyPid(); // remove in the future
    const PTPOI_BID_OFFSET = 1e10;
    let x = await fetchFamousVotes();
    x = x || {};
    // assign fake bids for these projected participants
    _.each(x, function(ptpt, pid) {
      pid = parseInt(pid);
      var bucketId = pid + PTPOI_BID_OFFSET; // should be safe to say there aren't 10 billion buckets, so we can use this range
      if (pid === myPid) {
        myBid = bucketId;
      }
      ptpt.fakeBid = bucketId;

      // default anon picture, may be overwritten
      ptpt.picture = anon_profile;

      if (ptpt.facebook &&
        ptpt.facebook.fb_user_id // TEMP - needed since I deleted some entries from facebook_users
      ) {
        ptpt.hasFacebook = true;
        var width = 48; // same as twitter, normally 50x50
        var height = 48; // same as twitter, normally 50x50
        ptpt.picture_size = 48;
        if (window.devicePixelRatio > 1) {
          // on retina, we'll show 32x32, but fetch 64x64 images
          width = 96; // facebook will return 64x64 images if we're on a retina device
          height = 96; // facebook will return 64x64 images if we're on a retina device
          ptpt.picture_size = 48;
        }

        // https://developers.facebook.com/docs/graph-api/reference/v2.2/user/picture
        ptpt.facebook.picture = "https://graph.facebook.com/v2.2/" + ptpt.facebook.fb_user_id + "/picture?width=" + width + "&height=" + height;
        ptpt.picture = ptpt.facebook.picture;
      }

      // override with Twitter if they have it
      if (ptpt.twitter) {
        ptpt.picture = ptpt.twitter.profile_image_url_https;
        ptpt.picture_size = 48; // twitter's _normal.JPG size. _mini would be 24, and _bigger would be 73
        ptpt.hasTwitter = true;
      }

      if (ptpt.xInfo) {
        ptpt.picture = ptpt.xInfo.x_profile_image_url;
        ptpt.picture_size = 48;
        ptpt.hasTwitter = false;
        ptpt.hasFacebook = false;
      }

      // override with custom polis picture if they have it
      if (ptpt.polis) {
        ptpt.picture = ptpt.polis.polis_pic;
      }
    });
    participantsOfInterestVotes = x;
    participantsOfInterestBids = _.map(_.values(participantsOfInterestVotes), "bid");
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

    buildFamousVotesObject();
  }
  

  return (
    <h1>Hello world</h1>
  )
}

export default Visualization3;