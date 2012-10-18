
var CommentShower = function($rootDomElem) {

    var pullCallbacks = $.Callbacks();
    var pushCallbacks = $.Callbacks();
    var shownCallbacks = $.Callbacks();
    var s = ServerClient({});

    var currentCommentId;

    $('#push_button').click(onPushClicked);
    $('#pull_button').click(onPullClicked);


    showNext();

    function showNext() {
        s.getNextComment().done(showComment);
    }
        

    // {id: 12345, text: "This is a great article dude."}
    function showComment(data) {

        var template = $('#showerTemplate').html();
        var html = Mustache.to_html(template, data);
        $rootDomElem.html(html);
        currentCommentId = data.id; 


        console.log("showing comment: " + currentCommentId);
        console.dir(data);

        // attach event listeners to buttons, and have them trigger onPushClicked, onPullClicked COMPLETED

        shownCallbacks.fire(data.id);
    }

    function onPushClicked() {
        pushCallbacks.fire(currentCommentId);
        // get the next comment from the ServerClient, and show that
        // transition
        showNext();
    }

    function onPullClicked() {
        pullCallbacks.fire(currentCommentId);
        // get the next comment from the ServerClient, and show that
        // transition
        showNext();
    }

    return {
        showComment : showComment,
        addPullListener: pullCallbacks.add,
        addPushListener: pushCallbacks.add,
        addShownListener: shownCallbacks.add,
    };
}
