var gulp = require('gulp');
var browserify = require('gulp-browserify');
var concat = require('gulp-concat'); 
var uglify = require('gulp-uglify')
var connect = require('gulp-connect'); 
var less = require('gulp-less');
var clean = require('gulp-clean');
var jshint = require('gulp-jshint');
var gzip = require('gulp-gzip');
var path = require('path');
var combineCSS = require('combine-css');
var gutil = require('gulp-util');
var handlebars = require('gulp-handlebars');
// var styl = require('gulp-styl');  
// var refresh = require('gulp-livereload');  
// var lr = require('tiny-lr');  
// var server = lr();
var header = require('gulp-header');
var hbsfy = require("hbsfy").configure({
  extensions: ["handlebars"]
});

gulp.task('connect', connect.server({
  root: __dirname + '/public',
  port: 8000,
  livereload: true,
  // open: {
  //   browser: 'chrome' // if not working OS X browser: 'Google Chrome'
  // }
}));

gulp.task('cleancss', function(){
  gulp.src('./public/css', {read: false})
      .pipe(clean())
})

gulp.task('less', function(){
  gulp.src(['css/**/*.less'])
      .pipe(less())
      // .pipe(combineCSS({
      //   selectorLimit: 4080
      // }))
      .pipe(gulp.dest('./public/css'))
});

gulp.task('templates', function(){
  gulp.src(['js/templates/*.hbs', 'js/templates/*.handlebars'])
    .pipe(handlebars({
      outputType: 'node',
      wrapped: true,
    }))
    .pipe(gulp.dest('js/tmpl'));
});

gulp.task('jshint', function(){
  gulp.src('js/**/*.js')
      .pipe(jshint())
      .pipe(jshint.reporter('default'))
})

gulp.task('scripts', ['templates', 'jshint'], function() {
  // Single entry point to browserify
  gulp.src('js/main.js')
      .pipe(browserify({
        insertGlobals : true,
        debug : false, //!gulp.env.production
        // transform: ['hbsfy'],
        shim : {
          //TODO 'handlebars': 'templates/helpers/handlebarsWithHelpers', //this one has polis custom template helpers
          handlebars: {
            path : 'bower_components/handlebars/handlebars.runtime.js', //original handlebars
            exports: 'Handlebars',
          },
          originalbackbone: {
            path: 'bower_components/backbone/backbone', // backbone before modifications
            depends: { jquery: '$', underscore: '_' },  
            exports: 'Backbone',
          },
          backbone: {
            path: 'js/net/backbonePolis', // polis-specific backbone modifications
            depends: { originalbackbone: "Backbone" },
            exports: "Backbone",
          },
          underscore: {
            path: 'bower_components/underscore/underscore',
            exports: '_',
          },
          thorax: {
            path: 'bower_components/thorax/thorax',
            depends: { handlebars: 'Handlebars', backbone: 'Backbone' },             
            exports: 'Thorax',
          },
          bootstrap_alert: {  //all bootstrap files need to be added to the dependency array of js/main.js
            path: 'bower_components/bootstrap/js/alert',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          bootstrap_tab: {
            path : 'bower_components/bootstrap/js/tab',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          bootstrap_popover: {
            path: 'bower_components/bootstrap/js/popover',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          bootstrap_collapse: {
            path: 'bower_components/bootstrap/js/collapse',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          bootstrap_dropdown: {
            path: 'bower_components/bootstrap/js/dropdown',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          bootstrap_affix: {
            path: 'bower_components/bootstrap/js/affix',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          d3tooltips: {
            path: 'bower_components/d3-tip/index',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          bootstrap_tooltip: {
            path: 'bower_components/bootstrap/js/tooltip',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          bootstrap_button: { 
            path: 'bower_components/bootstrap/js/button',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          bootstrap_transition: {
            path: 'bower_components/bootstrap/js/transition',
            depends: { jquery: "jQuery" },
            exports: null,
          },
          VisView: {
            path: 'js/lib/VisView',
            depends: { d3tooltips: 'foo' }, // added to d3 object as d3.tip
            exports: 'VisView',
          },
        },
      }))
      .pipe(gulp.dest('./public/js'))
});

gulp.task('squish', ['scripts'], function(){
  gulp.src("public/js/**/*.js")
      .pipe(concat('all.js'))
      .pipe(uglify())
      .pipe(gzip())
      .pipe(gulp.dest("public/FOOdist"))
});

gulp.task('default', ["connect", "scripts", "less", "squish"], function(){
  // place code for your default task here
});

gulp.task('deploy', ["scripts", "less", "squish"], function(){

})