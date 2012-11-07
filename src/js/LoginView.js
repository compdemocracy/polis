var LoginView = function(params) {
    var submit = params.submit;
    var onOk = params.onOk;
    var rootElemId = params.rootElemId;

    var deregisterCallbacks = $.Callbacks();

    $("#deregister_button").click( function() {
        deregisterCallbacks.fire();
    });

    // {email: "mike@foo.com", u: "myusername"}
    function render(data) {
        data = data || {};
        var template = $('#usernameTemplate').html();
        var html;
        if (data.email) {
            html = Mustache.to_html(template, {
                identity: data.email
            });
        } else if (data.username) {
            html = Mustache.to_html(template, {
                identity: data.username
            });
        } else {
            html = "";
        }
        $("#username_label").html(html);

        $("#" + rootElemId).removeClass("open");
    }

    function get(id) {
        return $('#' + id);
    }
    function getEmail() {
        return get(params.emailFieldId).val();
    }
    function getPassword() {
        return get(params.passwordFieldId).val();
    }
    function getPasswordAgain() { // if needed
        if (params.passwordAgainFieldId) {
            return get(params.passwordAgainFieldId).val();
        } else {
            return null;
        }
    }
    function getRememberMe() {
        return !!get(params.rememberMeFieldId).attr("checked");
    }

    function validateOk() {
        if (getPasswordAgain() !== null) {
            if (getPassword() !== getPasswordAgain()) {
                alert("passwords don't match");
                return false;
            }
        }
        if (getEmail().indexOf('@') === -1) {
            alert("invalid email address");
            return false;
        }
        return true;
    }

    function onError(data) {
        if (data === "polis_err_reg_user_exists") {
            alert("user exists");
        }
        console.error("auth error");
        console.dir(data);
    }

    function onSuccess(data) {
        render(data);
        onOk(data);
    }

    function onSubmit() {
        if (!validateOk()){
            return false;
        }
        submit({
            email: getEmail(),
            password: getPassword(),
            rememberMe: getRememberMe()
        }).then( onSuccess, onError);
        return false; // don't let browser handle it.
    }


    $("#" + params.formId).submit(onSubmit);

    return {
        render: render,
        addDeregisterListener: deregisterCallbacks.add
    };
};