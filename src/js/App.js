var App = function(params) {
    
    var utils = params.utils;
    var serverClient = params.serverClient;
    var CommentShower = params.CommentShower;
    var CommentSubmitter = params.CommentSubmitter;
    var loginView;
    var registerView;

    function observeStimulus(id) {
        // mostly for early dev, it would be nice to show the current stimulus in the hash params
        serverClient.observeStimulus(id);
    }

    function onDeregister() {
        serverClient.authDeregister().then(function() {
            loginView.render();
        }, function() {
            console.log("deregister failed");
        });
    }

    function setupUI() {

        // Comment Submitter
        var commentSubmitter= new CommentSubmitter({
            formId: '#comment_form'
        });
        commentSubmitter.addSubmitListener(function(txt) {
            serverClient.submitComment(txt);
        });

        loginView = new LoginView({
            rootElemId: "login_dropdown",
            submit: serverClient.authLogin,
            onOk: function() { console.log('login success'); },
            formId: "login_form",
            emailFieldId: "login_email",
            passwordFieldId: "login_password",
            rememberMeFieldId: "login_rememberme"
        });
        loginView.addDeregisterListener(onDeregister);
        loginView.render();

        registerView = new LoginView({
            rootElemId: "register_dropdown",
            submit: serverClient.authNew,
            onOk: function() { console.log('register success'); },
            formId: "register_form",
            emailFieldId: "register_email",
            passwordFieldId: "register_password",
            passwordAgainFieldId: "register_password_again",
            rememberMeFieldId: "register_rememberme"
        });
        registerView.addDeregisterListener(onDeregister);
        registerView.render();

        serverClient.addAuthStatChangeListener(function(e) {
            console.dir(e);
            if ("p_registered" === e.state) {
                //var username = e.username;
                //var email = e.email;
                // update UI
            } else if ("p_deregistered" === e.state) {
                // update UI
            }
        });

        // Comment Shower
        var $commentShowerElem = $("#comment_shower");
        var commentShower = new CommentShower({
            $rootDomElem: $commentShowerElem,
            serverClient: serverClient
        });

        commentShower.addPullListener(serverClient.pull);
        commentShower.addPushListener(serverClient.push);
        commentShower.addPassListener(serverClient.pass);
        commentShower.addShownListener(serverClient.see); // important that this one pass the commentid

        // hardcode the stimilus
        observeStimulus("5084f4f42985e5b6317ead7d");

        commentShower.showNext();
    }
    setupUI();

    
    // Debug interface
    return {
//        commentShower : commentShower,
        serverClient: serverClient
    };
};
    
$(document).ready(function() {
    var serverClient = new window.ServerClient({
        tokenStore: PolisStorage.token,
        emailStore: PolisStorage.email,
        usernameStore: PolisStorage.username,
        utils: window.utils,
        protocol: "", //"http",
        domain: "",// "polis.bjorkegren.com",
        basePath: "",
        logger: console
    });

    window.polisapp = new App({
        CommentShower: window.CommentShower,
        CommentSubmitter: window.CommentSubmitter,
        serverClient: serverClient,
        utils: window.utils
    });
});
