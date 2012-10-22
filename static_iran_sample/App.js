var polis = {};

var App = function() {
    
    var serverClient = ServerClient({
        me: 12345, // userid
        protocol: "http",
        domain: "polis.bjorkegren.com",
        basePath: "",
        logger: console,
    });

    function observeStimulus(id) {
        // mostly for early dev, it would be nice to show the current stimulus in the hash params
        window.location.hash = "#s=" + id
        serverClient.observe(id);
    }

    // init UI stuff
    // (or get references to the elements / views)

    serverClient.sync().then(setupUI, function() {
        alert("couldn't sync");
        setupUI();
    });

 function setupUI() {

    // Comment Submitter
    var commentSubmitter= CommentSubmitter({
    });
    commentSubmitter.addSubmitListener(function(text) {
        serverClient.submitComment(text);
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
    serverClient.getListOfUsersForThisTopic().always( function(users) {
        console.log("Current users for this topic:");
        console.dir(users);
    });
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
