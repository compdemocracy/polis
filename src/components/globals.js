export const sans = "Helvetica Neue";
export const serif = "Georgia";
export const paragraphWidth = 475;
export const paragraphLineHeight = "24px";
export const barChartWidth = 250;
export const side = 1200;

export const brandColors = {
  agree: "rgb(46, 204, 113)",
  agreeColorblind: "rgb(0, 140, 230)",
  disagree: "rgb(231, 76, 60)",
  pass: "rgb(230,230,230)",
  comment: "#03a9f4",
  yellowForRadial: "#DFE74D",
  blue: "#03A9F4",
  mediumGrey: "rgb(130,130,130)",
  lightgrey: "rgb(215,215,215)",
};

export const allCommentsSortDefault = "tid";


const fontSizes = {
  largest: 36,
  large: 24,
  medium: 18,
}

const fontWeights = {
  boldest: 700,
  normal: 400
}

export const primaryHeading = {
  fontSize: fontSizes.largest,
  fontWeight: fontWeights.boldest,
};

export const secondaryHeading = {
  fontSize: fontSizes.large,
  fontWeight: fontWeights.normal
}

export const groupHeader = {
  fontSize: fontSizes.largest,
  fontWeight: fontWeights.boldest,
}

export const overviewNumber = {
  fontSize: fontSizes.largest,
  fontWeight: fontWeights.normal,
  marginBottom: 0,
}

export const overviewLabel = {
  fontSize: fontSizes.medium,
  fontWeight: fontWeights.normal,
  marginTop: 0,
  maxWidth: 190
}

export const tidGrey = "rgb(200,200,200)";
export const paragraph = {
  width: paragraphWidth,
  fontFamily: serif,
  lineHeight: paragraphLineHeight,
}


// Duplicated in:
//   polisClientParticipation/vis2/components/globals.js
//   polisReport/src/components/globals.js
export const groupLabels = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]
export const groupSymbols = ["○", "◆", "+", "-", "◬",  "▮", ]


export const enableMatrix = false;
// export const maxCommentExtremityToShow = 2; /* naive & may not be solid. should be dynamically generated from extremity array probably to pick top 20 or something */
export const maxCommentExtremityToShow = .6; /* naive & may not be solid. should be dynamically generated from extremity array probably to pick top 20 or something */
export const labelPadding = 40;
export const shouldColorizeTidsByRepfulness = true;


// ====== REMEMBER: gid's start at zero, (0, 1, 2) but we show them as group 1, 2, 3 =======

export const groupColor = (gid) => {
  if (gid === 0) {
    return "#7f63b8";
  } else if (gid === 1) {
    return "#86a542";
  } else if (gid === 2) {
    return "#b84c7d";
  } else if (gid === 3) {
    return "#50b47b";
  } else if (gid === 4) {
    return "#b94c3e";
  } else if (gid === 5) {
    return "#c18839";
  } else {
    return "rgb(255, 0, 0)";
  }
};

export const antiRepfulColor = "black";

// ====== REMEMBER: gid's start at zero, (0, 1, 2) but we show them as group 1, 2, 3 =======

export const getGroupNamePosition = (gid) => {
  if (gid === 0) {
    return "translate(200,550)";
  }
  if (gid === 1) {
    return "translate(555,255)";
  }
  return "translate(50, 50)";
};
