const _ = require('underscore');

function strToHex(str) {
  let hex, i;
  // let str = "\u6f22\u5b57"; // "\u6f22\u5b57" === "漢字"
  let result = "";
  for (i = 0; i < str.length; i++) {
    hex = str.charCodeAt(i).toString(16);
    result += ("000" + hex).slice(-4);
  }
  return result;
}

function hexToStr(hexString) {
  let j;
  let hexes = hexString.match(/.{1,4}/g) || [];
  let str = "";
  for (j = 0; j < hexes.length; j++) {
    str += String.fromCharCode(parseInt(hexes[j], 16));
  }
  return str;
}

function getInt(s) {
  return new Promise(function(resolve, reject) {
    if (_.isNumber(s) && s >> 0 === s) {
      return resolve(s);
    }
    let x = parseInt(s);
    if (isNaN(x)) {
      return reject("polis_fail_parse_int " + s);
    }
    resolve(x);
  });
}

function getBool(s) {
  return new Promise(function(resolve, reject) {
    let type = typeof s;
    if ("boolean" === type) {
      return resolve(s);
    }
    if ("number" === type) {
      if (s === 0) {
        return resolve(false);
      }
      return resolve(true);
    }
    s = s.toLowerCase();
    if (s === 't' || s === 'true' || s === 'on' || s === '1') {
      return resolve(true);
    } else if (s === 'f' || s === 'false' || s === 'off' || s === '0') {
      return resolve(false);
    }
    reject("polis_fail_parse_boolean");
  });
}

function getIntInRange(min, max) {
  return function(s) {
    return getInt(s).then(function(x) {
      if (x < min || max < x) {
        throw "polis_fail_parse_int_out_of_range";
      }
      return x;
    });
  };
}

function extractFromQueryOrBody(req, name) {
  let ret = extractFromQuery(req, name);
  if (ret) {
    return ret;
  } else {
    return extractFromBody(req, name);
  }
}

function extractFromQuery(req, name) {
  if (name in req.query) {
    return req.query[name];
  }
  return void 0;
}

function extractFromBody(req, name) {
  if (!req.body) {
    return void 0;
  }
  return req.body[name];
}

function extractFromCookie(req, name) {
  if (!req.cookies) {
    return void 0;
  }
  return req.cookies[name];
}

function extractFromHeader(req, name) {
  if (!req.headers) {
    return void 0;
  }
  return req.headers[name.toLowerCase()];
}

const polisTypes = {
  reactions: {
    push: 1,
    pull: -1,
    see: 0,
    pass: 0,
  },
  staractions: {
    unstar: 0,
    star: 1,
  },
  mod: {
    ban: -1,
    unmoderated: 0,
    ok: 1,
  },
};
polisTypes.reactionValues = _.values(polisTypes.reactions);
polisTypes.starValues = _.values(polisTypes.staractions);

module.exports = {
  strToHex,
  hexToStr,
  getInt,
  getBool,
  getIntInRange,
  extractFromQueryOrBody,
  extractFromQuery,
  extractFromBody,
  extractFromCookie,
  extractFromHeader,
  polisTypes
};