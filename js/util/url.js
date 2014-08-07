
// build may prepend 'devWithPreprod'

var prod = "https://pol.is/";
var preprod = "https://preprod.pol.is/";
var localhost = "http://localhost:5000/";
var localhost8000 = "http://localhost:8000/";
var urlPrefix = prod;
if (document.domain.indexOf("preprod") >= 0) {
    urlPrefix = preprod;
}
if (-1 === document.domain.indexOf("pol.is")) {
    urlPrefix = localhost;
}
if (document.domain === "localhost" && document.location.port === "8000") { 
	urlPrefix = localhost8000;
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