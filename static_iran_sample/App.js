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

    commentShower.addPullListener(serverClient.pull);
    commentShower.addPushListener(serverClient.push);
    commentShower.addPassListener(serverClient.pass);
    commentShower.addShownListener(serverClient.see); // important that this one pass the commentid

    observeStimulus("5084f4f42985e5b6317ead7d");

    commentShower.showNext();
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
