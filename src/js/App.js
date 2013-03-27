function getLocationHash() {
    var pairs = {};
    var kv = location.hash.slice(1).split("&").map(function(kv) { return kv.split("=");});
    for (var i = 0; i < kv.length; i++) {
        pairs[kv[i][0]] = kv[i][1];
    }
    return pairs;
}

function shouldShowFirstTimeUserExperience() {
    return !PolisStorage.personId.get();
}

function navigateToWriteTab(e) {
    if (e && e.preventDefault) { 
        e.preventDefault();
    }
    $(".write_tab").tab('show');
    $("#comment_form_textarea").focus();
}
function navigateToReactTab(e) {
    if (e && e.preventDefault) { 
        e.preventDefault();
    }
    $(".react_tab").tab('show');
}
function showTopicModal() {
    //alert("In Seattle, aisudhfius ashdfalis dfhias udfhliuas dfhkas ufhlaksiudhfauis dfhkldsfku sadfh asudhfo aisufsufasdhfiuadhiu aefw uirh weoiuhr uiwereyruw eyro iweuryoi weuyru wef g fd h fg h fgdg sn luahfiluafleidsuhsf s d fpa iusdfpjip asdp if ipa spidif ijpi dsaip fi adisu i  fahuihefas");
}

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

    var shouldPollForMoreComments = false;
    var commentPollInterval = 5 * 1000;

    function pollForComments() {
        if (shouldPollForMoreComments) {
            serverClient.syncAllCommentsForCurrentStimulus();
        }
    }
    setInterval(pollForComments, commentPollInterval);

    function finishedAllComments() {
        var promises = serverClient.stories().map(function(storyId) {
            var dfd = $.Deferred();
            serverClient.syncAllCommentsForCurrentStimulus(storyId).always(function() {
                serverClient.getNextComment(storyId).then(
                    function(x) {
                        dfd.reject();
                    },
                    function(x) {
                        shouldPollForMoreComments = true;
                        dfd.resolve();
                    });
            });
            return dfd;
        });
        return $.when.apply($, promises);
    }
    function checkForGameOver() {
        function finished() {
            //$('#feedback_modal').modal('show');
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
        document.title= "Polis topic: Legalization";
    }
    var setStimulusOnFirstLoad = _.once(function() {
        var stim = "514ac77ba313c76729000008";
        var kv = getLocationHash();
        if (kv.s) {
            stim = kv.s;
        }
        setStimulus(stim);
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
            alert("Thanks! let's see what happens.");
            navigateToReactTab();
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
            personIdStore: PolisStorage.personId,
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
                //$('#create_user_modal').modal('hide'); 
                //$('#introduction_modal').modal('hide');
                
                //add close button and enable background click so users can
                //close intro modal if clicked from menu after login
                //$('#introduction_modal').removeAttr('data-backdrop');
                //$('#introduction_modal_button').removeAttr('disabled'); 

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

        serverClient.addCommentsAvailableListener(commentShower.notifyCommentsAvailable);

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
        personIdStore: PolisStorage.personId,
        //commentsStore: PolisStorage.comments,
        //reactionsByMeStore: PolisStorage.reactionsByMe,
        utils: window.utils,
        protocol: "", //"http",
        domain: "",// "polis.bjorkegren.com",
        basePath: "",
        logger: console
    });

    // serverClient = PolisClientForStudents(serverClient);


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
        var pairs = getLocationHash();
        if (pairs.s) { // stimulus
            setStimulus(pairs.s);
        }
    }
    window.addEventListener("hashchange", locationHashChanged);

    function promptUserToRegister() {
        $('#introduction_modal').modal('show');
        $('#create_user_modal').modal('show');
    }
    if (!serverClient.authenticated()) {
        //promptUserToRegister();
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
        serverClient.getLatestEvents().then( function(comments) {
            events.forEach(function(e) {
                // try various event handlers
                onModeChange(e);
            });
        }, function(err) {
            console.error("couldn't getLatestComments... ");
            console.dir(err);
        });
    }, 1000);
    */

    serverClient.addAuthNeededListener(promptUserToRegister);

    KeyboardJS.on('ctrl + m', function() {
        serverClient.submitEvent({
            ev: "commentingOnly"
        });
    });

    KeyboardJS.on('ctrl + r', function() {
        serverClient.submitEvent({
            ev: "ratingOnly"
        });
    });
    //serverClient.addModeChangeEventListener(onModeChange);




    var initPcaVis = function() {
        var w = $("#visualization_div").width();
        var h = w/2;
        $("#visualization_div").height(h);
        PcaVis.initialize({
            getPersonId: PolisStorage.personId.get,
            getCommentsForProjection: serverClient.getCommentsForProjection,
            getCommentsForSelection: serverClient.getCommentsForSelection,
            w: w,
            h: h,
            el_queryResultSelector: "#query_results_div",
            el: "#visualization_div"
        });
    };

    var onResize = _.throttle(function onResize(){
        //var resizeArticleHeight = $(window).height() * 0.68;
        //var resizeShowerHeight = $(window).height() * 0.70;
        //$('#articles').css('height', resizeArticleHeight);
        //$('#comment_shower').css('height', resizeShowerHeight);
        //
        //
        //    initPcaVis(); 
        setTimeout(function() {
            window.location.reload(true); // force get
        }, 500);

    },1000);

    //$("#topic_modal").click(showTopicModal);
    //$('#topic_modal').modal({show: false, keyboard: true, backdrop: true});

    $('.react_tab').click(navigateToReactTab);
    $('.write_tab').click(navigateToWriteTab);

    serverClient.addPersonUpdateListener( function(e) {
        PcaVis.upsertNode(e);
    });

    if (shouldShowFirstTimeUserExperience()) {

        //alert("Welcome to Polis");
    }

    if (window.localStorage.getItem("lastFTUX") < Date.now()- 1000*60 ) {
        bootstro.start();
        window.localStorage.setItem("lastFTUX", Date.now());
    }

window.newUser = function() {
    PolisStorage.token.clear();
    PolisStorage.email.clear();
    PolisStorage.username.clear();
    PolisStorage.personId.clear();
    serverClient.authDeregisterClientOnly();
    setTimeout(function() {
        window.location.reload(true); // force get
    }, 100);
};
KeyboardJS.on("ctrl+n", newUser);
    


        
// hack_ios_hide_locationbar
// Be sure the document is taller than the window
// http://mobile.tutsplus.com/tutorials/mobile-web-apps/remove-address-bar/
function hideAddressBar()
{
  if(!window.location.hash)
  {
      if(document.height < window.outerHeight)
      {
          document.body.style.height = (window.outerHeight + 50) + 'px';
      }
 
      setTimeout( function(){ window.scrollTo(0, 1); }, 0);
  }
}
 
window.addEventListener("load", function(){ if(!window.pageYOffset){ hideAddressBar(); } } );
window.addEventListener("orientationchange", hideAddressBar );

            
    $(window).resize(onResize);
    initPcaVis();
});
