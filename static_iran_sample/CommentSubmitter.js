

var CommentSubmitter = function(params) {

    var submitCallbacks = $.Callbacks();

    $(params.formId).submit(onSubmit);

    function onSubmit() {
        var txt = $('#comment_form_textarea').val();
        submitCallbacks.fire(txt);
        return false; // don't let browser handle it.
    }


    return {
        addSubmitListener: submitCallbacks.add,
    };
}
