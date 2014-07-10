
var urlPrefix = "https://pol.is/";
if (document.domain.indexOf("preprod") >= 0) {
    urlPrefix = "https://preprod.pol.is/";  
}
if (-1 === document.domain.indexOf("pol.is")) {
    urlPrefix = "http://localhost:5000/";
}


module.exports = {
  urlPrefix: urlPrefix
};