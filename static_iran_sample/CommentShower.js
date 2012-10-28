
var CommentShower = function(params) {
    var $rootDomElem = params.$rootDomElem;
    var serverClient = params.serverClient;

    var pullCallbacks = $.Callbacks();
    var pushCallbacks = $.Callbacks();
    var passCallbacks = $.Callbacks();
    var shownCallbacks = $.Callbacks();

    var currentCommentId;

    $('#push_button').click(onPushClicked);
    $('#pull_button').click(onPullClicked);
    $('#pass_button').click(onPassClicked);



    function showNext() {
        serverClient.getNextComment().done(showComment);
    }
        

    // {_id: 12345, txt: "This is a great article dude."}
    function showComment(data) {

        var template = $('#showerTemplate').html();
        var html = Mustache.to_html(template, data);
        $rootDomElem.html(html);
        currentCommentId = data._id; 


        console.log("showing comment: " + currentCommentId);
        console.dir(data);

        // attach event listeners to buttons, and have them trigger onPushClicked, onPullClicked COMPLETED

        shownCallbacks.fire(currentCommentId);
    }

    function onPushClicked() {
        pushCallbacks.fire(currentCommentId);
        showNext();
    }

    function onPassClicked() {
        passCallbacks.fire(currentCommentId);
        showNext();
    }

    function onPullClicked() {
        pullCallbacks.fire(currentCommentId);
        showNext();
    }

    return {
        showNext: showNext,
        showComment : showComment,
        addPullListener: pullCallbacks.add,
        addPushListener: pushCallbacks.add,
        addPassListener: passCallbacks.add,
        addShownListener: shownCallbacks.add,
    };
}
