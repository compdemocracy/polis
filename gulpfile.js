var gulp = require('gulp');
var browserify = require('gulp-browserify');
var concat = require('gulp-concat');  
var gutil = require('gulp-util');
var handlebars = require('gulp-handlebars');
// var styl = require('gulp-styl');  
// var refresh = require('gulp-livereload');  
// var lr = require('tiny-lr');  
// var server = lr();


gulp.task('templates', function(){
  gulp.src(['templates/*.hbs', 'templates/*.handlebars'])
    .pipe(handlebars({
      outputType: 'bare'
     }))

    // .pipe(declare({
    //   namespace: 'MyApp.templates'
    // }))
    // .pipe(concat('templates.js'))
    .pipe(gulp.dest('js/tmpl'));
});

gulp.task('scripts', ['templates'], function() {
    // Single entry point to browserify
    gulp.src('js/main.js')
        .pipe(browserify({
          insertGlobals : true,
          debug : false, //!gulp.env.production
          transform: ['hbsfy'],
          shim : {

 //TODO 'handlebars': 'templates/helpers/handlebarsWithHelpers', //this one has polis custom template helpers

        // d3 is conditionally loaded from index
        // 'd3': '../bower_components/d3/d3',
        // 'r2d3': '../bower_components/r2d3/r2d3',

        // no need to shim jQuery

            // jquery: {
            //   path: "lib/jquery", // Note: these jquery files were generated from this fork: https://github.com/mbjorkegren/jquery/tree/1.9-callbacks-array-fix
            //   exports: "$",
            // },
            originalhandlebars: {
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
              exports: null,
            },
            bootstrap_tab: {
              path : 'bower_components/bootstrap/js/tab',
              exports: null,
            },
            bootstrap_popover: {
              path: 'bower_components/bootstrap/js/popover',
              exports: null,
            },
            bootstrap_collapse: {
              path: 'bower_components/bootstrap/js/collapse',
              exports: null,
            },
            bootstrap_dropdown: {
              path: 'bower_components/bootstrap/js/dropdown',
              exports: null,
            },
            bootstrap_affix: {
              path: 'bower_components/bootstrap/js/affix',
              exports: null,
            },
            d3tooltips: {
              path: 'bower_components/d3-tip/index',
              exports: null,
            },
            bootstrap_tooltip: {
              path: 'bower_components/bootstrap/js/tooltip',
              exports: null,
            },
            bootstrap_button: { 
              path: 'bower_components/bootstrap/js/button',
              exports: null,
            },
            bootstrap_transition: {
              path: 'bower_components/bootstrap/js/transition',
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