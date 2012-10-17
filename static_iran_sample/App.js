var polis = {};

var App = function() {
    
    var serverClient = ServerClient({
        userID: 12345,
        domain: "polisapp.com",
    });


    // init UI stuff
    // (or get references to the elements / views)

    var $commentShowerElem = $("#comment_shower");
    var commentShower = CommentShower($commentShowerElem, serverClient.getNextComment);

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

    
    // Debug interface
    return {
        commentShower : commentShower,
        serverClient: serverClient,
    }
};
    
$(document).ready(function() {
    polis.app = App();
});
