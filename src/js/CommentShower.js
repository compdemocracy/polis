
var CommentShower = function(params) {
    var $rootDomElem = params.$rootDomElem;
    var serverClient = params.serverClient;

    var pullCallbacks = $.Callbacks();
    var pushCallbacks = $.Callbacks();
    var passCallbacks = $.Callbacks();
    var shownCallbacks = $.Callbacks();

    var currentCommentId;

    var buttons = [
        $('#push_button'),
        $('#pull_button'),
        $('#pass_button')
    ];
    function showButtons() {
        buttons.forEach(function(b) {
            b.show();
        });
    }
    function hideButtons() {
        buttons.forEach(function(b) {
            b.hide();
        });
    }

    function showNext() {
        return serverClient.getNextComment().always(showComment);
    }
        

    // {_id: 12345, txt: "This is a great article dude."}
    function showComment(data) {
        var template,
            html;

        if (!data) {
            $rootDomElem.html("<h3>You've finished reacting to comments for the current article, please select the next article to proceed.</h3>");
            hideButtons();
            return;
        }
        showButtons();

        template = $('#showerTemplate').html();
        html = Mustache.to_html(template, data);
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
