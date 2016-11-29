// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

// build may prepend 'devWithPreprod'

var prod = "https://pol.is/";
var preprod = "https://preprod.pol.is/";
var embed = "https://embed.pol.is/";
var survey = "https://survey.pol.is/";
var localhost = "http://localhost:5000/";
var localhost8000 = "http://localhost:8000/";
var urlPrefix = prod;
if (document.domain.indexOf("preprod") >= 0) {
  urlPrefix = preprod;
}
if (document.domain.indexOf("embed") >= 0) {
  urlPrefix = embed;
}
if (document.domain.indexOf("survey") >= 0) {
  urlPrefix = survey;
}
if ((-1 === document.domain.indexOf("pol.is")) && (-1 === document.domain.indexOf("polis.io"))) {
  urlPrefix = localhost;
}

if (document.domain === "localhost" && document.location.port === "8000") {
  urlPrefix = localhost8000;
}

if (0 === document.domain.indexOf("192.168")) {
  urlPrefix = "http://" + document.location.hostname + ":" + document.location.port + "/";
}

function isPreprod() {
  return urlPrefix === preprod;
}

function isLocalhost() {
  return urlPrefix === localhost || urlPrefix === localhost8000;
}

module.exports = {
  urlPrefix: urlPrefix,
  isPreprod: isPreprod,
  isLocalhost: isLocalhost
};
