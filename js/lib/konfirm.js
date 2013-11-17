// Function Binder

var functionBinder = function(fn, me) {
    "use strict";
    return function () {
        return fn.apply(me, arguments);
    };
};

var konfirm = (function(){

  function konfirm(options){

    // Set options

    this.message = options.message || null;
    this.success = options.success || null;
    this.cancel = options.cancel || null;
    this.dialog = null;
    this.successTrigger = null;
    this.cancelTrigger = null;
    this.shade = null;

    // Bind clicks

    this.successHandler = functionBinder(this.successHandler, this);
    this.cancelHandler = functionBinder(this.cancelHandler, this);

    // Trigger build
    this.buildOut();
    // Position
    this.position();
    // Bind events
    this.bindEvents();

    this.successTrigger.focus();

  }

  konfirm.prototype.buildOut = function() {
    this.dialog = $("<div class='konfirm-dialog'><p class='message'>" + this.message + "</p></div>").appendTo("body");
    this.shade = $("<div class='konfirm-shade'/>").appendTo("body");
    this.cancelTrigger = $("<a href='javascript:void(0)' class='btn btn-danger'>Cancel</a>").appendTo(this.dialog);
    this.successTrigger = $("<a href='javascript:void(0)' class='btn btn-success'>Ok</a>").appendTo(this.dialog);
  };

  konfirm.prototype.position = function() {
    var ww,wh,dw,dh,nt,nl = null;
    ww = $(window).width();
    wh = $(window).height();
    dw = this.dialog.outerWidth();
    dh = this.dialog.outerHeight();
    nt = (wh - dh) / 2;
    nl = (ww - dw) / 2;
    this.dialog.css({left: nl, top: nt});
  };

  konfirm.prototype.bindEvents = function() {
    this.successTrigger.on("click", this.successHandler);
    this.cancelTrigger.on("click", this.cancelHandler);
  };

  konfirm.prototype.successHandler = function() {
    this.success();
    this.dialog.remove();
    this.shade.remove();
  };

  konfirm.prototype.cancelHandler = function() {
    this.cancel();
    this.dialog.remove();
    this.shade.remove();
  };

  return konfirm;

})();

window.konfirm = konfirm;