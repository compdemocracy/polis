define([
    'originalbackbone'
], function(Backbone) {
    
    var api_version = "v3";

    /*  
        Method to HTTP Type Map 
    */
    var methodMap = {
        'create': 'POST',
        'update': 'PUT',
        'delete': 'DELETE',
        'read':   'GET'
    };

    /* 
        Override the default Backbone.sync 
    */
    var ajaxSync = Backbone.sync;
    Backbone.sync = function(method, model, options) {
        
        var object_id = model.models? "" : model.id; //get id if it is not a Backbone Collection

        var class_name = model.path || model.name;
        if (!class_name) {
            throw "class name misssing from model";
        }

        // create request parameteres
        var type = methodMap[method];
        options || (options = {});
        //var base_url = "https://api.parse.com/" + api_version + "/classes";
        //var base_url = "/" + api_version;
        var protocol = "http://";
        var firstPart = protocol + "api.polis.io/";
        if (-1 === document.domain.indexOf(".polis.io")) {
            firstPart = protocol + "localhost:5000/";
        }
        var base_url = firstPart + api_version

        //var base_url = "http://localhost:5000/" + api_version;
        var url = base_url + "/" + class_name + "/";
        if (method != "create") {
            url = url + object_id;
        }
       
        //Setup data
        var data ;
        if (!options.data && model && (method == 'create' || method == 'update')) {
          data = JSON.stringify(model.toJSON());
        }
        else if (options.query && method == "read") { //query for Parse.com objects
            data = encodeURI(options.query);
        }   

        var request = {
            //data
            contentType: "application/json",
            processData: false,
            dataType: 'json',
            data: data,

            //action
            url: url,
            type: type,

            //authentication
            headers: {
                "Cache-Control": "max-age=0"
                //"Cache-Control": "no-cache"
                //"X-Parse-Application-Id": application_id,
                //"X-Parse-REST-API-Key": rest_api_key
            },
            xhrFields: {
                withCredentials: true
            },
            crossDomain: true
        };

        return $.ajax(_.extend(options, request));
    };
    console.log('foo');
    console.log(Backbone);
    return Backbone;
});
