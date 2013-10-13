define([
  'view',
  'templates/landing-page',
  'anystretch'
], function (View, template) {
  return View.extend({
    name: 'landingPage',
    template: template,
    initialize: function(){
    	this.listenTo(this, 'rendered', function(){
    		this.$('#conductor').anystretch("img/conductor.jpeg");
    	})
    }
  });
});
