
var CommentShower = function(params) {
    var $rootDomElem = params.$rootDomElem;
    var serverClient = params.serverClient;

    var pullCallbacks = $.Callbacks();
    var pushCallbacks = $.Callbacks();
    var passCallbacks = $.Callbacks();
    var shownCallbacks = $.Callbacks();

    var currentCommentId;

    function showNext() {
        serverClient.getNextComment().done(showComment);
    }
        

    // {_id: 12345, txt: "This is a great article dude."}
    function showComment(data) {

        if (!data) {
            var template = $('#feedbackTemplate').html();
            var html = Mustache.to_html(template, {});
            $rootDomElem.html(html);
        }

        var template = $('#showerTemplate').html();
        var html = Mustache.to_html(template, data);
        $rootDomElem.html(html);
        currentCommentId = data._id; 


        console.log("showing comment: " + currentCommentId);
        console.dir(data);

        // attach event listeners to buttons, and have them trigger onPushClicked, onPullClicked COMPLETED

        serverClient.see(currentCommentId);
        shownCallbacks.fire(currentCommentId);
    }

    function onPushClicked() {
        serverClient.push(currentCommentId);
        showNext();
        pushCallbacks.fire(currentCommentId);
    }

    function onPassClicked() {
        serverClient.pass(currentCommentId);
        showNext();
        passCallbacks.fire(currentCommentId);
    }

    function onPullClicked() {
        serverClient.pull(currentCommentId);
        showNext();
        pullCallbacks.fire(currentCommentId);
    }

    $('#push_button').click(onPushClicked);
    $('#pull_button').click(onPullClicked);
    $('#pass_button').click(onPassClicked);

    return {
        addPullListener: pullCallbacks.add,
        addPushListener: pushCallbacks.add,
        addPassListener: passCallbacks.add,
        addShownListener: shownCallbacks.add,
        showComment : showComment,
        showNext: showNext
    };
};
