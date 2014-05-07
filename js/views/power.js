var AnalyzeGlobalView = require("../views/analyze-global");
var Backbone = require("backbone");
var eb = require("../eventBus");
var template = require('../tmpl/power');
var ConversationStatsHeader = require('../views/conversation-stats-header');


var display = require("../util/display");
var ResultsView = require("../views/results-view");
var VoteModel = require("../models/vote");
var ParticipantModel = require("../models/participant");
var ConversationView = require("../views/conversation");
var CommentModel = require("../models/comment");
var UserModel = require("../models/user");
var CommentsCollection = require("../collections/comments");
var ResultsCollection = require("../collections/results");
var RulesCollection = require("../collections/rules");
var RulesView = require("../views/rules");
var Utils = require("../util/utils");
var VisView = require("../lib/VisView");


var VIS_SELECTOR = "#visualization_div";

var isIE8 = navigator.userAgent.match(/MSIE [89]/);

module.exports =  ConversationView.extend({
  name: "powerView",
  template: template,
  events: {
    "click #reproject": function() {
      this.doReproject();
    },
    "dragstart": function(ev) {
      console.log("dragging");
      var s = ev.target.id;
      if (!s) {
        s = ev.target.id = "draggable_" + Math.random();
      }
      ev.originalEvent.dataTransfer.setData("Text",s);
    },
    "drop #dragtarget": function(ev) {
      console.log("drop");
      ev.preventDefault();
      var data=ev.originalEvent.dataTransfer.getData("Text");
      var target = ev.target;
      if (target.id !== "dragtarget") {
        target = $("#dragtarget")[0];
      }
      target.appendChild(document.getElementById(data));
    },
    "dragover #dragtarget": function(ev) {
      console.log("dragover");
      ev.preventDefault();
      // allow drop
    }

  },
  onAnalyzeTabPopulated: function() {
    $('.query_result_item').first().trigger('click');
  },
  hideVis: function() {
    $("#visualization_div").hide();
  },
  showVis: function() {
    $("#visualization_div").show();
  },
  allowMetadataFiltering: function() {
    return true;
  },

  emphasizeParticipants: function() {
    if (this.vis) {
      this.vis.emphasizeParticipants.apply(this, arguments);
    }
  },
  initialize: function(options) {
    ConversationView.prototype.initialize.apply(this, arguments);
    var that = this;
    var vis;
    var zid = this.zid;
    var pid = this.pid;
    var zinvite = this.zinvite;
    var serverClient = this.serverClient;


    this.conversationStatsHeader = new ConversationStatsHeader();


    var resultsCollection = new ResultsCollection();


    var rulesCollection = new RulesCollection();
    this.rulesView = this.addChild(new RulesView({
      collection: rulesCollection
    }));

    // HTTP PATCH - model.save({patch: true})

    function onPersonUpdate() {
      if (vis) {
        vis.upsertNode.apply(vis, arguments);
      }
    }


    function configureGutters() {     
      if (display.xs()) {
        $("#controlTabs").addClass("no-gutter");
      } else {
        $("#controlTabs").removeClass("no-gutter");        
      }
    }


    function initPcaVis() {

      $(VIS_SELECTOR).html("").height(0);
      // $(VIS_SELECTOR).parent().css("display", "none");



      var w = $(VIS_SELECTOR).width();
      if (isIE8) {
        w = 500;
        $(VIS_SELECTOR).width(w);
      }
      var h = w/2;
      $(VIS_SELECTOR).height(h);
      that.serverClient.removePersonUpdateListener(onPersonUpdate);
      vis = that.vis = new VisView({
          getPid: function() {
            if (!_.isId(pid)) {
              //alert("bad pid: " + pid);
            }
            return pid;
          },
          isIE8: isIE8,
          getCommentsForProjection: serverClient.getCommentsForProjection,
          getCommentsForGroup: serverClient.getCommentsForGroup,
          getReactionsToComment: serverClient.getReactionsToComment,
          getPidToBidMapping: serverClient.getPidToBidMapping,
          w: w,
          h: h,
          computeXySpans: Utils.computeXySpans,
          el_queryResultSelector: ".query_results_div",
          el: VIS_SELECTOR,
          el_raphaelSelector: VIS_SELECTOR, //"#raphael_div",
      });

      that.serverClient.addPersonUpdateListener(onPersonUpdate)

      that.tutorialController.setHandler("blueDot", function(){
        that.$blueDotPopover = that.$(VIS_SELECTOR).popover({
          title: "DOTS ARE PEOPLE",
          content: "Each dot represent one or more people. The blue circle represents you. By reacting to a comment, you have caused your dot to move. As you and other participants react, you will move closer to people who reacted similarly to you, and further from people who reacted differently. <button type='button' id='blueDotPopoverButton' class='btn btn-lg btn-primary' style='display: block; margin-top:20px'> Ok, got it </button>",
          html: true,
          trigger: "manual",
          placement: "bottom"
        }).popover("show");
        $('#blueDotPopoverButton').click(function(){
          that.$blueDotPopover.popover("destroy");
        });
      });
      that.tutorialController.setHandler("shadedGroup", function(){
        that.$shadedGroupPopover = that.$(VIS_SELECTOR).popover({
          title: "CLICK ON GROUPS",
          content: "Shaded areas represent groups. Click on a shaded area to show comments that most represent this group's opinion, and separate this group from the other groups.<button type='button' id='shadedGroupPopoverButton' class='btn btn-lg btn-primary' style='display: block; margin-top:20px'> Ok, got it </button>",
          html: true, 
          trigger: "manual",
          placement: "bottom"
        }).popover("show");
        $('#shadedGroupPopoverButton').click(function(){
          that.$shadedGroupPopover.popover("destroy");
        });
      });
      that.tutorialController.setHandler("analyzePopover", function(){
        setTimeout(function(){
          if (!that.$el) {
            return;
          }
          that.$analyzeViewPopover = that.$('.query_results > li').first().popover({
            title: "COMMENTS FOR THIS GROUP",
            content: "Clicking on a shaded area brings up the comments that brought this group together: comments that were agreed upon, and comments that were disagreed upon. Click on a comment to see which participants agreed (green/up) and which participants disagreed (red/down) across the whole conversation. Participants who haven't reacted to the selected comment disappear. <button type='button' id='analyzeViewPopoverButton' class='btn btn-lg btn-primary' style='display: block; margin-top:20px'> Ok, got it </button>",
            html: true,
            trigger: "manual",
            placement: "bottom"  
          });
          that.$('.query_result_item').first().trigger('click');
          that.$analyzeViewPopover.popover("show");
          that.$('#analyzeViewPopoverButton').click(function(){
            that.$analyzeViewPopover.popover("destroy");
          })      
        },1500)
      }) 
    }  

    // just a quick hack for now.
    // we may need to look into something more general
    // http://stackoverflow.com/questions/11216392/how-to-handle-scroll-position-on-hashchange-in-backbone-js-application
    var scrollTopOnFirstShow = _.once(function() {
      // scroll to top
      window.scroll(0,0);
    });


      /* child views */

      this.commentsByMe = new CommentsCollection({
        zid: zid,
        pid: pid
      });

      this.resultsView = this.addChild(new ResultsView({
        serverClient: serverClient,
        zid: zid,
        collection: resultsCollection
      }));


      this.analyzeGlobalView = this.addChild(new AnalyzeGlobalView({
        zid: zid,
        isIE8: isIE8,
        getTidsForGroup: function() {
          return that.serverClient.getTidsForGroup.apply(0, arguments);          
        },
        collection: this.allCommentsCollection
      }));

      eb.on(eb.commentSelected, function(tid) {
        vis.selectComment(tid);
      });

      // this.votesByMe.on("all", function(x) {
      //   console.log("votesByMe.all", x);
      // });
      // this.votesByMe.on("change", function() {
      //   console.log("votesByMe.change");
      //   serverClient.updateMyProjection(that.votesByMe);
      // });
      var updateMyProjectionAfterAddingVote = _.throttle(function() {
        console.log("votesByMe.add");
        setTimeout(function() {
          serverClient.updateMyProjection(that.votesByMe);
        }, 300); // wait a bit to let the dot blink before moving it.
      }, 200);
      this.votesByMe.on("add", updateMyProjectionAfterAddingVote);

    // Clicking on the background dismisses the popovers.
    this.$el.on("click", function() {
      that.destroyPopovers();
    });

    eb.on(eb.clusterClicked, this.onClusterTapped.bind(this));
    eb.on(eb.queryResultsRendered, this.onAnalyzeTabPopulated.bind(this));


    this.doReproject = _.debounce(serverClient.updateMyProjection, 1000);


    this.listenTo(this, "render", function(){
      setTimeout(function() {

      scrollTopOnFirstShow();

      // $("#visualization_div").affix({
      //   offset: {
      //     top: 150 //will be set dynamically
      //   }
      // });
      function deselectHulls() {
        if (vis) {
          vis.deselect();
        }
      }      
      configureGutters();
      if (isIE8) {
        // Can't listen to the "resize" event since IE8 fires a resize event whenever a DOM element changes size.
        // http://stackoverflow.com/questions/1852751/window-resize-event-firing-in-internet-explorer
       setTimeout(initPcaVis, 10); // give other UI elements a chance to load
        // document.body.onresize = _.debounce(initPcaVis, 1000)
      } else {
        setTimeout(initPcaVis, 10); // give other UI elements a chance to load        
        $(window).resize(_.debounce(function() {
          configureGutters();
          initPcaVis();
        }, 100));
      }



      that.allCommentsCollection.doFetch().then(function() {
        that.analyzeGlobalView.sortAgree();
      });
      

  }, 0); // end listenTo "render"
  });
  this.render();
  } // end initialize
});