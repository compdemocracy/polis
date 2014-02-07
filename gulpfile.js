var gulp = require('gulp');
var browserify = require('gulp-browserify');
var gutil = require('gulp-util');

var concat = require('gulp-concat');  
// var styl = require('gulp-styl');  
// var refresh = require('gulp-livereload');  
// var lr = require('tiny-lr');  
// var server = lr();



gulp.task('scripts', function() {
    // Single entry point to browserify
    gulp.src('js/main.js')
        .pipe(browserify({
          insertGlobals : true,
          debug : false, //!gulp.env.production
 'handlebars': 'templates/helpers/handlebarsWithHelpers', //this one has polis custom template helpers
          shim : {

        // d3 is conditionally loaded from index
        // 'd3': '../bower_components/d3/d3',
        // 'r2d3': '../bower_components/r2d3/r2d3',

            jquery: {
              path: "lib/jquery", // Note: these jquery files were generated from this fork: https://github.com/mbjorkegren/jquery/tree/1.9-callbacks-array-fix
              exports: "$",
            },
            originalhandlebars: {
              path : '../bower_components/handlebars/handlebars.runtime', //original handlebars
              exports: 'Handlebars',
            },
            originalbackbone: {
              path: '../bower_components/backbone/backbone', // backbone before modifications
              depends: { jquery: '$', underscore: '_' },  
              exports: 'Backbone',
            },
            backbone: {
              path: 'net/backbonePolis', // polis-specific backbone modifications
              depends: { originalbackbone: "Backbone" },
              exports: "Backbone",
            },
            underscore: {
              path: '../bower_components/underscore/underscore',
              exports: '_',
            },
            thorax: {
              path: '../bower_components/thorax/thorax',
              exports: 'Thorax',
              depends: { handlebars: 'Handlebars', backbone: 'Backbone' },             
            },
            bootstrap_alert: {  //all bootstrap files need to be added to the dependency array of js/main.js
              path: '../bower_components/bootstrap/js/alert',
            },
            bootstrap_tab: {
              path : '../bower_components/bootstrap/js/tab',
            },
            bootstrap_popover: {
              path: '../bower_components/bootstrap/js/popover',
            },
            bootstrap_collapse: {
              path: '../bower_components/bootstrap/js/collapse',
            },
            bootstrap_dropdown: {
              path: '../bower_components/bootstrap/js/dropdown',
            },
            bootstrap_affix: {
              path: '../bower_components/bootstrap/js/affix',
            },
            d3tooltips {
              path: '../bower_components/d3-tip/index',
            },
            bootstrap_tooltip: {
              path: '../bower_components/bootstrap/js/tooltip',
            },
            bootstrap_button: { 
              path: '../bower_components/bootstrap/js/button',
            },
            bootstrap_transition: {
              path: '../bower_components/bootstrap/js/transition',
            },
            polis: {
              path: 'lib/polis',
            },
            VisView: {
              path: 'lib/VisView',
              depends: { d3tooltips: 'foo' }, // added to d3 object as d3.tip
              exports: 'VisView',
            },
          },
        }))
        .pipe(gulp.dest('./public/js'))
});


// gulp.task('scripts', function() {  
//     gulp.src(['js/**/*.js'])
//         // .pipe(browserify())
//         .pipe(concat('main.js'))
//         .pipe(gulp.dest('build'))
//         // .pipe(refresh(server))
// });

gulp.task('default', ["scripts"], function(){
  // place code for your default task here
});