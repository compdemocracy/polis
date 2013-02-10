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

    function finishedAllComments() {
        var promises = serverClient.stories().map(function(storyId) {
            var dfd = $.Deferred();
            serverClient.syncAllCommentsForCurrentStimulus(storyId).always(function() {
                serverClient.getNextComment(storyId).then(
                    function(x) {
                        dfd.reject();
                    },
                    function(x) {
                        dfd.resolve();
                    });
            });
            return dfd;
        });
        return $.when.apply($, promises);
    }
    function checkForGameOver() {
        function finished() {
            $('#feedback_modal').modal('show');
        }
        _.defer(function() {
            finishedAllComments().then( finished );
        });
    }

    function setStimulus(stimulusId) {
        stimulusId = "string" === typeof stimulusId ? stimulusId : this.dataset.stimulusId;
        serverClient.observeStimulus(stimulusId);
        serverClient.syncAllCommentsForCurrentStimulus().always( function() {
                commentShower.showNext().always(checkForGameOver);
        });
    }
    var setStimulusOnFirstLoad = _.once(function() {
        setStimulus("509c9db2bc1e120000000001");
        //setStimulus($(".stimulus_link").first().addClass("active").data().stimulusId);
    });

    function onDeregister() {
        serverClient.authDeregister().then(function() {
            loginView.render();
        }, function() {
            console.log("deregister failed");
        });
    }

    function setupUI() {

        if (!serverClient.authenticated()) {
            serverClient.authNew({ anon: true, rememberMe: true});
        }

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

        // FeedbackSubmitter that's shown in the intro
        var feedbackSubmitterIntro = new FeedbackSubmitter({
            form: $('#introduction_feedback_form')
        });
        feedbackSubmitterIntro.addSubmitListener(function(data) {
            serverClient.submitFeedback(data);
            feedbackSubmitterIntro.clear();
            alert("Thank you - Your feedback was sent.");
        });

        // FeedbackSubmitter that's shown after all comments are rated
        var feedbackSubmitterFinished = new FeedbackSubmitter({
            form: $('#finished_feedback_form')
        });
        feedbackSubmitterFinished.addSubmitListener(function(data) {
            serverClient.submitFeedback(data);
            feedbackSubmitterFinished.clear();
            $('#feedback_modal').modal('hide');
            _.defer(function() {
                finishedAllComments().done(function() {
                    $('#thank_you_modal').modal('show'); 
                });
            });
        });

        loginView = new LoginView({
            emailStore: PolisStorage.email,
            usernameStore: PolisStorage.username,
            rootElemId: "create_user_modal",
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
            rootElemId: "create_user_modal",
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


        function onRegistered(e) {
                //var username = e.username;
                //var email = e.email;
                // update UI

                //hide modals when user successfully registers
                $('#create_user_modal').modal('hide'); 
                $('#introduction_modal').modal('hide');
                
                //add close button and enable background click so users can
                //close intro modal if clicked from menu after login
                $('#introduction_modal').removeAttr('data-backdrop');
                $('#introduction_modal_button').removeAttr('disabled'); 

                registerView.render();
                loginView.render();
                setStimulusOnFirstLoad();
                checkForGameOver();
        }

        serverClient.addAuthStatChangeListener(function(e) {
            console.dir(e);
            if ("p_registered" === e.state) {
                onRegistered(e);
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

        commentShower.addPullListener(checkForGameOver);
        commentShower.addPushListener(checkForGameOver);
        commentShower.addPassListener(checkForGameOver);
        //commentShower.addShownListener(serverClient.see); // important that this one pass the commentid

        $(".stimulus_link").click(setStimulus);
        // Start with a default stimulus.
        $(".stimulus_link").first().parent().addClass("active");

        if (serverClient.authenticated()) {
            onRegistered();
        }
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

    function onModeChange(e) {
        if (!e.ev) {
            console.error("missing e.ev");
            return;
        }
        if (e.ev === "commentingOnly") {
            console.log('commentingOnly');
        } else if (e.ev === "ratingOnly") {
            console.log('ratingOnly');
        }
    }


    /*
    setInterval(function() {
        serverClient.getLatestComments().then( function(comments) {
            // template + comments --> html
            $("#asdfasdf").append($(result of above line));
            
        }, function(err) {
            console.error("couldn't getLatestComments... ");
            console.dir(err);
        });
    }, 5000);
    */

    setInterval(function() {
        serverClient.getLatestEvents().then( function(comments) {
            events.forEach(function(e) {
                // try various event handlers
                onModeChange(e);
            });
        }, function(err) {
            console.error("couldn't getLatestComments... ");
            console.dir(err);
        });
    });

    serverClient.addAuthNeededListener(promptUserToRegister);

    KeyboardJS.on('ctrl + m', function() {
        serverClient.submitEvent({
            ev: "commentingOnly",
        });
    });

    KeyboardJS.on('ctrl + r', function() {
        serverClient.submitEvent({
            ev: "ratingOnly",
        });
    });
    serverClient.addModeChangeEventListener(onModeChange);


    function onResize(){
        var resizeArticleHeight = $(window).height() * 0.68;
        var resizeShowerHeight = $(window).height() * 0.70;
        $('#articles').css('height', resizeArticleHeight);
        $('#comment_shower').css('height', resizeShowerHeight);
    }
            
    $(window).resize(onResize);
    onResize();
});
