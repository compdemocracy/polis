

var FeedbackSubmitter = function(params) {

    var submitCallbacks = $.Callbacks();

    params.form.submit(onSubmit);

    function onSubmit() {
        var feedback = params.form.find(".feedback_text").val();
        var ui_location = params.form.find('[name=ui_location]').val();
        submitCallbacks.fire({
            feedback: feedback,
            ui_location: ui_location
        });
        return false; // don't let browser handle it.
    }

    function clear() {
        params.form[0].reset();
    }

    return {
        clear: clear,
        addSubmitListener: submitCallbacks.add
    };
};
