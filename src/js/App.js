var App = function(params) {
    
    var utils = params.utils;
    var serverClient = params.serverClient;
    var CommentShower = params.CommentShower;
    var CommentSubmitter = params.CommentSubmitter;
    var StimulusSubmitter = params.StimulusSubmitter;
    var loginView;
    var registerView;

    var commentSubmitter;
    var commentShower;

    var logger = console;

    function setStimulus(stimulusId) {
        stimulusId = "string" === typeof stimulusId ? stimulusId : this.dataset.stimulusId;
        serverClient.observeStimulus(stimulusId);
        serverClient.syncAllCommentsForCurrentStimulus().then(
            commentShower.showNext,
            commentShower.showNext
        );
    }

    function onDeregister() {
        serverClient.authDeregister().then(function() {
            loginView.render();
        }, function() {
            console.log("deregister failed");
        });
    }

    function setupUI() {

        // CommentSubmitter
        commentSubmitter= new CommentSubmitter({
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

                //hide modals when user successfully registers
                $('#create_user_modal').modal('hide'); 
                $('#introduction_modal').modal('hide');
                
                //add close button and enable background click so users can
                //close intro modal if clicked from menu after login
                $('#introduction_modal').removeAttr('data-backdrop')
                $('#introduction_modal_button').removeAttr('disabled'); 

                registerView.render();
                loginView.render();
                setStimulusOnFirstLoad();
            } else if ("p_deregistered" === e.state) {
                //registerView.render();
                //loginView.render();
                _.defer(function() {
                    window.location = window.location;
                });
                // update UI
            }
        });

        // Comment Shower
        var $commentShowerElem = $("#comment_shower");
        commentShower = new CommentShower({
            $rootDomElem: $commentShowerElem,
            serverClient: serverClient
        });

        //commentShower.addPullListener(serverClient.pull);
        //commentShower.addPushListener(serverClient.push);
        //commentShower.addPassListener(serverClient.pass);
        //commentShower.addShownListener(serverClient.see); // important that this one pass the commentid

        $(".stimulus_link").click(setStimulus);
        // Start with a default stimulus.
        $(".stimulus_link").first().parent().addClass("active");

        var setStimulusOnFirstLoad = _.once(function() {
            setStimulus($(".stimulus_link").first().addClass("active").data().stimulusId);
        });

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
        //commentsStore: PolisStorage.comments,
        //reactionsByMeStore: PolisStorage.reactionsByMe,
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

    function promptUserToRegister() {
        $('#introduction_modal').modal('show');
        $('#create_user_modal').modal('show');
    }
    if (!serverClient.authenticated()) {
        promptUserToRegister();
    }

    serverClient.addAuthNeededListener(promptUserToRegister);

    function onResize(){
        var resizeArticleHeight = $(window).height() * 0.80;
        var resizeShowerHeight = $(window).height() * 0.70;
        $('#articles').css('height', resizeArticleHeight);
        $('#comment_shower').css('height', resizeShowerHeight);
    }
            
    $(window).resize(onResize);
    onResize();
});
