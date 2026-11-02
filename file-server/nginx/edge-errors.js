// Match the file-server's finalhandler 404 response. Use the original escaped
// path (without its query), not nginx's decoded/normalized $uri. The variable
// is evaluated only by the local return, never on API or page requests.
function notFound(r) {
    var path = r.variables.request_uri.split(/[?#]/)[0];
    // Preserve existing URL escapes and brackets. Encode unsafe characters,
    // then escape HTML, just as finalhandler does for its resource name.
    path = path.replace(/%[0-9a-fA-F]{2}|[^%]+|%/g, function (part) {
        if (/^%[0-9a-fA-F]{2}$/.test(part)) return part;
        return encodeURI(part).replace(/%5B/g, '[').replace(/%5D/g, ']');
    });
    var escapes = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
    var message = ('Cannot ' + r.method + ' ' + path).replace(/[&<>"']/g, function (c) {
        return escapes[c];
    });
    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
        '<title>Error</title>\n</head>\n<body>\n<pre>' + message + '</pre>\n</body>\n</html>\n';
}
export default {notFound};
