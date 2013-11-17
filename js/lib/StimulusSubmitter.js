

var StimulusSubmitter = function(params) {

    var submitCallbacks = $.Callbacks();

    $(params.formId).submit(onSubmit);

    function onSubmit() {
        var txt = $("#stimulus_form_textarea").val();
        var title = $("#stimulus_form_title").val();
        var authors = $("#stimulus_form_authors_commaseparated").val().split(",");
        var organization = $("#stimulus_form_authors_organization").val();
        submitCallbacks.fire( assemble({
            title: title,
            authors: authors,
            organization: organization,
            txt: txt
        }));
        return false; // don"t let browser handle it.
    }


    return {
        addSubmitListener: submitCallbacks.add
    };
};
