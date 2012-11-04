var App = function(params) {
    
    var utils = params.utils;
    var serverClient = params.serverClient;
    var CommentShower = params.CommentShower;
    var CommentSubmitter = params.CommentSubmitter;

    function observeStimulus(id) {
        // mostly for early dev, it would be nice to show the current stimulus in the hash params
        serverClient.observeStimulus(id);
    }

    // init UI stuff
    // (or get references to the elements / views)

 function setupUI() {

    // Comment Submitter
    var commentSubmitter= new CommentSubmitter({
     formId: '#comment_form'
    });
    commentSubmitter.addSubmitListener(function(txt) {
        serverClient.submitComment(txt);
    });

    // Comment Shower
    var $commentShowerElem = $("#comment_shower");
    var commentShower = new CommentShower({
        $rootDomElem: $commentShowerElem,
        serverClient: serverClient
    });

    commentShower.addPullListener(serverClient.pull);
    commentShower.addPushListener(serverClient.push);
    commentShower.addPassListener(serverClient.pass);
    commentShower.addShownListener(serverClient.see); // important that this one pass the commentid

    observeStimulus("5084f4f42985e5b6317ead7d");

    commentShower.showNext();
}
    setupUI();

    
    // Debug interface
    return {
//        commentShower : commentShower,
        serverClient: serverClient
    };
};
    
$(document).ready(function() {
    var serverClient = new window.ServerClient({
        token: PolisStorage.token,
        username: PolisStorage.username,
        utils: window.utils,
        protocol: "", //"http",
        domain: "",// "polis.bjorkegren.com",
        basePath: "",
        logger: console
    });

    window.polisapp = new App({
        CommentShower: window.CommentShower,
        CommentSubmitter: window.CommentSubmitter,
        serverClient: serverClient,
        utils: window.utils
    });
});
