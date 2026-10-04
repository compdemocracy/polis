// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

// The numeric vote wire, owned here and nowhere else in this client.
//
// POST /api/v3/votes and POST /api/v3/comments carry `vote` as a number, and
// GET /votes, /votes/me and participationInit return it the same way. That
// number is the WIRE convention: agree = -1, disagree = +1, pass = 0. The wire
// is frozen (P-078 ruling R-wire): it never flips, whatever the server stores,
// so this client never needs to know how votes are stored.
//
// Everything else in the client speaks the semantic names 'agree', 'disagree'
// and 'pass', and converts at the edge with toWire() / fromWire().

var WIRE_AGREE = -1;
var WIRE_DISAGREE = 1;
var WIRE_PASS = 0;

var WIRE = Object.freeze({
  AGREE: WIRE_AGREE,
  DISAGREE: WIRE_DISAGREE,
  PASS: WIRE_PASS
});

var AGREE = "agree";
var DISAGREE = "disagree";
var PASS = "pass";

var SEMANTIC_TO_WIRE = Object.freeze({
  agree: WIRE_AGREE,
  disagree: WIRE_DISAGREE,
  pass: WIRE_PASS
});

// The server encodes participant vote vectors (`famous`, ptptoi `votes`) as one
// letter per comment: a = agree, d = disagree, p = pass, u = unseen.
var LETTER_TO_SEMANTIC = Object.freeze({
  a: AGREE,
  d: DISAGREE,
  p: PASS
});
var LETTER_UNSEEN = "u";

// 'agree' | 'disagree' | 'pass' -> the wire number. Throws on anything else.
function toWire(semantic) {
  if (!Object.prototype.hasOwnProperty.call(SEMANTIC_TO_WIRE, semantic)) {
    throw new Error("voteConvention.toWire: not a vote: " + String(semantic));
  }
  return SEMANTIC_TO_WIRE[semantic];
}

// A wire number -> 'agree' | 'disagree' | 'pass', or null for anything that is
// not exactly one of the three wire values (strict equality, no coercion).
function fromWire(value) {
  if (value === WIRE_AGREE) return AGREE;
  if (value === WIRE_DISAGREE) return DISAGREE;
  if (value === WIRE_PASS) return PASS;
  return null;
}

// A vote-vector letter -> 'agree' | 'disagree' | 'pass', or null for unseen
// ('u') and for any letter the server does not emit.
function fromLetter(letter) {
  return Object.prototype.hasOwnProperty.call(LETTER_TO_SEMANTIC, letter) ? LETTER_TO_SEMANTIC[letter] : null;
}

function isAgree(value) {
  return value === WIRE_AGREE;
}
function isDisagree(value) {
  return value === WIRE_DISAGREE;
}
function isPass(value) {
  return value === WIRE_PASS;
}

// The served PCA geometry is in the wire's axis, so a comment is drawn where a
// participant who agreed with it would project: its raw component is scaled by
// the wire value of agree (P-078 §1f). Not a vote; it moves only with the wire.
var COMMENT_PLACEMENT_SIGN = WIRE_AGREE;

module.exports = {
  WIRE: WIRE,
  WIRE_AGREE: WIRE_AGREE,
  WIRE_DISAGREE: WIRE_DISAGREE,
  WIRE_PASS: WIRE_PASS,
  AGREE: AGREE,
  DISAGREE: DISAGREE,
  PASS: PASS,
  LETTER_UNSEEN: LETTER_UNSEEN,
  toWire: toWire,
  fromWire: fromWire,
  fromLetter: fromLetter,
  isAgree: isAgree,
  isDisagree: isDisagree,
  isPass: isPass,
  COMMENT_PLACEMENT_SIGN: COMMENT_PLACEMENT_SIGN
};
