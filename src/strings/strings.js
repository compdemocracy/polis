
import en_us from "./en_us";

var s = {};

// TODO port language choosing code
s = en_us;


function f(key) {
  // strip whitespace from key
  key = key.replace(/\s+$/,"").replace(/^\s+/,"");
  if (typeof s[key] === "undefined") {
    return key;
  }
  return s[key];
}

export default f;
