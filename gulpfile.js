"use strict";

var gulp = require('gulp');
var eslint = require('gulp-eslint');
//var gulpif = require('gulp-if');
//var gutil = require('gulp-util');
//var path = require('path');
//var Promise = require('es6-promise').Promise;
//var proxy = require('proxy-middleware');
//var fs = require('fs');
//var mapStream = require('map-stream');
//var request = require('request');
//var rimraf = require("rimraf");
//var runSequence = require('run-sequence');
//var sys = require('sys');
//var url = require('url');

gulp.task('lint', function() {
  gulp.src(['*.js', 'js/**/*.js'])
    .pipe(eslint({

      rules: {
        // "unused":false,
        // "no-empty": 0,
        // "reporter": 'jslint',
        "curly": 1, // require if,else blocks to have {}
        "eqeqeq": 1,


        "comma-dangle": 0, // TODO SWITCH TO THIS: "comma-dangle": [1, "always-multiline"],

        // "immed": 1,
        // "latedef": 1,
        // "newcap": 1,
        // "noarg": 1,
        // "sub": 1,
        // "undef": 1,
        // "unused": 1,
        "quotes": 0,
        // "plusplus": 1, // no ++ or --
        // "nonew": 1,
        "no-caller": 1, // no arguments.caller and arguments.callee (allow for optimizations)
        // "latedef": "nofunc",
        "indent": ["error", 2],
        "wrap-iife": 1,
        // "forin": 1, require hasOwnProperty checks
        // "boss": 1,
        // "debug": 1, // uncomment temporarily when you want to allow debugger; statements.
        // "browser": 1,
        // "relax": eventually we should get rid of these
        //"expr": 1,
        // "loopfunc": 1,
        //"shadow": 1,
        "new-cap": 0, // might be nice
        "no-extra-strict": 0,
        "global-strict": 0,
        "no-trailing-spaces": 0, // might be nice
        "camelcase": 0,
        "no-shadow": 0, // might be nice
        "comma-spacing": 0, // might be nice
        "space-infix-ops": 0,
        "semi-spacing": 0,
        "no-use-before-define": 0, // might be nice
        "no-unused-vars": 0, // might be nice
        "key-spacing": 0, // might be nice
        "yoda": 0,
        "handle-callback-err": 0, // SHOULD PROBABLY SWITCH THIS TO 1
        "no-multi-spaces": 0, // might be nice
        "no-mixed-requires": 0,
        "no-process-exit": 0,
        "no-extend-native": 0,
        "consistent-return": 0, // might be nice
        "no-extra-boolean-cast": 0,
        "no-underscore-dangle": 0,
        "no-empty": 0, // might be nice?
      }, // end rules
      globals: {
        d3: true,
        jQuery: true,
        console: true,
        require: true,
        define: true,
        requirejs: true,
        describe: true,
        expect: true,
        module: true,
        // it: true
      },
      envs: [
        "node",
      ],
    }))
    // .pipe(eslint.reporter('default'));
    .pipe(eslint.formatEach('compact', process.stderr))
    // To have the process exit with an error code (1) on
    // lint error, return the stream and pipe to failOnError last.
    .pipe(eslint.failOnError());
});



gulp.task('default', [
  "lint",
], function() {});
