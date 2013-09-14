/********** PARSE API ACCESS CREDENTIALS **********/
//var application_id = "CkWCHMSOgyqoNKoIc5hu09uvdZcJ9rpHJD4iwhxI";
//var rest_api_key = "H5SIwarTRXqd07C0OIZPbcRTYTNLKsjFAJt5PrFY";
var api_version = "v3";
/******************* END *************************/

(function() {

    /*  
        Replace the toJSON method of Backbone.Model with our version
        
        This method removes the "createdAt" and "updatedAt" keys from the JSON version 
        because otherwise the PUT requests to Parse fails.
     */
    var original_toJSON = Backbone.Model.prototype.toJSON; 
    var ParseModel = {
        toJSON : function(options) {
            _parse_class_name = this.__proto__._parse_class_name;
            data = original_toJSON.call(this,options);
            delete data.createdAt
            delete data.updatedAt
            return data
        },

        idAttribute: "objectId"
    };
    _.extend(Backbone.Model.prototype, ParseModel);

    /*  
        Replace the parse method of Backbone.Collection

        Backbone Collection expects to get a JSON array when fetching.
        Parse returns a JSON object with key "results" and value being the array.
    */
    original_parse =Backbone.Collection.prototype.parse; 
    var ParseCollection = {
        parse : function(options) {
            _parse_class_name = this.__proto__._parse_class_name;
            data = original_parse.call(this,options);
            if (_parse_class_name && data.results) {
                //do your thing
                return data.results;
            }
            else {
                //return original
                return data;
            }
        }
    };
    _.extend(Backbone.Collection.prototype, ParseCollection);

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
    var ajaxSync = Backbone.Sync;
    Backbone.sync = function(method, model, options) {
        

        var object_id = model.models? "" : model.id; //get id if it is not a Backbone Collection


        var class_name = model.__proto__._parse_class_name;
        if (!class_name) {
            return ajaxSync(method, model, options) //It's a not a Parse-backed model, use default sync
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

})();
