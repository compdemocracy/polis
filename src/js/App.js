var App = function(params) {
    
    var utils = params.utils;
    var serverClient = params.serverClient;
    var CommentShower = params.CommentShower;
    var CommentSubmitter = params.CommentSubmitter;
    var StimulusSubmitter = params.StimulusSubmitter;
    var loginView;
    var registerView;

    function onDeregister() {
        serverClient.authDeregister().then(function() {
            loginView.render();
        }, function() {
            console.log("deregister failed");
        });
    }

    function setupUI() {

        // CommentSubmitter
        var commentSubmitter= new CommentSubmitter({
            formId: '#comment_form'
        });
        commentSubmitter.addSubmitListener(function(txt) {
            serverClient.submitComment(txt);
        });

        // StimulusSubmitter
        var stimulusSubmitter = new StimulusSubmitter({
            formId: '#stimulus_form'
        });
        stimulusSubmitter.addSubmitListener(function(data) {
            serverClient.submitStimulus(data);
        });

        loginView = new LoginView({
            emailStore: PolisStorage.email,
            usernameStore: PolisStorage.username,
            rootElemId: "login_dropdown",
            submit: serverClient.authLogin,
            onOk: function() { console.log('login success'); },
            formId: "login_form",
            emailFieldId: "login_email",
            passwordFieldId: "login_password",
            rememberMeFieldId: "login_rememberme"
        });
        loginView.addDeregisterListener(onDeregister);
        loginView.render({
            email: PolisStorage.email.get()
        });

        registerView = new LoginView({
            emailStore: PolisStorage.email,
            usernameStore: PolisStorage.username,
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
                registerView.render();
                loginView.render();
            } else if ("p_deregistered" === e.state) {
                registerView.render();
                loginView.render();
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

    }
    setupUI();

    
    // Debug interface
    return {
//        commentShower : commentShower,
        serverClient: serverClient
    };
};
    
$(document).ready(function() {

    window.debug = {};
    window.debug.enterComments = function() { $("#comment_form").removeClass("debug_hidden"); };
    window.debug.enterStim = function() { $("#stimulus_form").removeClass("debug_hidden"); };

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
        StimulusSubmitter: window.StimulusSubmitter,
        serverClient: serverClient,
        utils: window.utils
    });

    function locationHashChanged(e) {
        console.log(e);
        alert(location.hash);
        if (location.hash === "#somecoolfeature") {
            somecoolfeature();
        }
    }
    window.addEventListener("hashchange", locationHashChanged);

    function setStimulus(stimulusId) {
        stimulusId = stimulusId || this.dataset.stimulusId;
        serverClient.observeStimulus(stimulusId);
        commentShower.showNext();
    }
    $(".stimulus_link").click(setStimulus);
    // Start with a default stimulus.
    $(".stimulus_link").first().parent().addClass("active");
    setStimulus($(".stimulus_link").first().addClass("active").data().stimulusId);


});
