var gulp = require('gulp');
var browserify = require('gulp-browserify');

var concat = require('gulp-concat');  
// var styl = require('gulp-styl');  
// var refresh = require('gulp-livereload');  
// var lr = require('tiny-lr');  
// var server = lr();



// gulp.task('scripts', function() {
//     // Single entry point to browserify
//     gulp.src('js/main.js')
//         .pipe(browserify({
//           insertGlobals : true,
//           debug : !gulp.env.production
//         }))
//         .pipe(gulp.dest('./public/js'))
// });


gulp.task('scripts', function() {  
    gulp.src(['js/**/*.js'])
        // .pipe(browserify())
        .pipe(concat('main.js'))
        .pipe(gulp.dest('build'))
        // .pipe(refresh(server))
})