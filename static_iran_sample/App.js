var polis = {};

var App = function() {
    
    var serverClient = ServerClient({
        me: 12345, // userid
        protocol: "", //"http",
        domain: "",// "polis.bjorkegren.com",
        basePath: "",
        logger: console,
    });

    function observeStimulus(id) {
        // mostly for early dev, it would be nice to show the current stimulus in the hash params
        serverClient.observeStimulus(id);
    }

    // init UI stuff
    // (or get references to the elements / views)

    //serverClient.authenticate("mike", "12345").then(
    serverClient.authAnonNew().then(
        function(authData) {
            onAuthenticated(authData);
            setupUI();
        }, 
        function() {alert('login failed');}
    );

    function onAuthenticated(data) {
        console.log("Your userid is " + data.u);
    }

 function setupUI() {

    // Comment Submitter
    var commentSubmitter= CommentSubmitter({
     formId: '#comment_form',
    });
    commentSubmitter.addSubmitListener(function(txt) {
        serverClient.submitComment(txt);
    });

    // Comment Shower
    var $commentShowerElem = $("#comment_shower");
    var commentShower = CommentShower({
        $rootDomElem: $commentShowerElem,
        serverClient: serverClient,
    });

    commentShower.addPullListener(function(commentID) {
        serverClient.pull(commentID)
            .done(
                function() {
                    console.log("pull ok");
                })
            .fail(
                function(error) {
                    console.error("failed to pull");
                    console.dir(error);
                });
    });

    commentShower.addPushListener(function(commentID) {
        serverClient.push(commentID)
            .done(
                function() {
                    console.log("push ok");
                })
            .fail(
                function(error) {
                    console.error("failed to push");
                    console.dir(error);
                });
    });

    observeStimulus("5084f4f42985e5b6317ead7d");
}
    
    // Debug interface
    return {
//        commentShower : commentShower,
        serverClient: serverClient,
    }
};
    
$(document).ready(function() {
    polis.app = App();
});
