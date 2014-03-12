var api_version = "v3";

var originalAjax = Backbone.ajax;
Backbone.ajax = function(url, options) {
    // this block is from jQuery.ajax
    // If url is an object, simulate pre-1.5 signature
	if ( typeof url === "object" ) {
		options = url;
		url = options.url; // this part is different than jQuery.ajax (it would set url to null)
	}

    var protocol = "//";
    var firstPart = protocol + "pol.is/";
    if (-1 === document.domain.indexOf("pol.is")) {
        firstPart = protocol + "localhost:5000/";
    }
    var base_url = firstPart + api_version + "/";

    //var base_url = "http://localhost:5000/" + api_version;
    url = base_url + url;

    var request = {
        //data
        contentType: "application/json",
        processData: false,
        dataType: "json",
        data: options.data,

        //authentication
        headers: {
            "Cache-Control": "max-age=0"
            //"Cache-Control": "no-cache"
            //"X-Parse-Application-Id": application_id,
            //"X-Parse-REST-API-Key": rest_api_key
        },
        // crossDomain: true,
        xhrFields: {
            withCredentials: true
        }
    };

    return originalAjax(url, $.extend(true, options, request));
};

