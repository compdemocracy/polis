export const sans = "Montserrat, ";
export const serif = "Source Serif Pro, Georgia";
export const paragraphWidth = 475;
export const paragraphLineHeight = "24px";
export const barChartWidth = 250;
export const primaryHeading = 36;
export const secondaryHeading = 18;

export const tidGrey = "rgb(200,200,200)";
export const paragraph = {
  width: paragraphWidth,
  fontFamily: serif,
  lineHeight: paragraphLineHeight
}


export const enableMatrix = false;

export const side = 750;
export const labelPadding = 40;
export const shouldColorizeTidsByRepfulness = true;

export const axisLabels = {
  leftArrow: "⟵",
  rightArrow: "⟶",
  xLeft: "Anti-Renzi, anti-centralization",
  xRight: "Pro-Renzi, centralization",
  yRight: "Participatory process is best",
  yLeft: "Leave it to the government"
};

// ====== REMEMBER: gid's start at zero, (0, 1, 2) but we show them as group 1, 2, 3 =======

export const groupColor = (gid) => {
  if (gid === 0) {
    return "#91bfdb"; /* light blue */
  } else if (gid === 1) {
    return "#fc8d62"; /* bright orange salmon */
  } else if (gid === 2) {
    return "#984ea3"; /* dark purple */
  } else if (gid === 3) {
    return "#bababa"; /* dark grey */
  } else if (gid === 4) {
    return "#80cdc1"; /* teal */
  } else if (gid === 5) {
    return "rgb(179, 90, 30)";
  } else {
    return "rgb(255, 0, 0)";
  }
};

export const antiRepfulColor = "red";

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
