import _ from 'underscore';
function strToHex(str) {
  let hex, i;
  let result = '';
  for (i = 0; i < str.length; i++) {
    hex = str.charCodeAt(i).toString(16);
    result += ('000' + hex).slice(-4);
  }
  return result;
}
function hexToStr(hexString) {
  let j;
  let hexes = hexString.match(/.{1,4}/g) || [];
  let str = '';
  for (j = 0; j < hexes.length; j++) {
    str += String.fromCharCode(parseInt(hexes[j], 16));
  }
  return str;
}
let polisTypes = {
  reactions: {
    push: 1,
    pull: -1,
    see: 0,
    pass: 0
  },
  staractions: {
    unstar: 0,
    star: 1
  },
  mod: {
    ban: -1,
    unmoderated: 0,
    ok: 1
  }
};
polisTypes.reactionValues = _.values(polisTypes.reactions);
polisTypes.starValues = _.values(polisTypes.staractions);
export { strToHex, hexToStr, polisTypes };
export default { strToHex, hexToStr, polisTypes };
