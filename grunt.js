module.exports = function(grunt) {

 	// readOptionalJSON
 	// by Ben Alman
 	// https://gist.github.com/2876125
 	function readOptionalJSON( filepath ) {
 		var data = {};
 		try {
 			data = grunt.file.readJSON( filepath );
 			grunt.verbose.write( "Reading " + filepath + "..." ).ok();
 		} catch(e) {}
 		return data;
 	}
 
    var jsFiles = [
        //'grunt.js',
        'src/**/*.js'
        ////'src/js/*.js',
        ////'src/desktop/src/*.js',
        ////'src/mobile/src/*.js',
        //'test/**/*.js'
   ];

  // Project configuration.
  grunt.initConfig({
    pkg: '<json:package.json>', // fetch pkg.name, etc from package.json
    meta: {
        banner: "/*! <%= pkg.name %> - v<%= pkg.version %> polisapp.com | polisapp.org/license <%= grunt.template.today('yyyy-mm-dd') %> */"
    },
//  test: {
//    files: ['test/**/*.js']
//  },
    lint: {
      files: grunt.file.expandFiles(jsFiles).filter(function(path) {
                 // don't run lint on libraries
                 console.dir(path);
                 return path.indexOf("/lib/") < 0;
             })
    },
    concat: {
      dist: {
          src: ['<banner:meta.banner>'].concat(jsFiles),
          dest: 'dist/polis-min.js',
          separator: ";"
        }
    },
    jshint: readOptionalJSON( ".jshintrc" ) || {},

    //forever: {
        //main: 'server/polis_v1.js'
    //},
    watch: {
      files: '<config:lint.files>',
      tasks: 'default'
    }
  });

  //grunt.loadNpmTasks('grunt-forever');

    grunt.registerTask('copy-html', function() {
        function copyFile(path) {
            console.log(path);
            grunt.file.copy(path, [dest, path].join('/'));
        }
        grunt.file.setBase("src");
        var dest = "../dist"
        grunt.file.expandFiles("*.html").forEach(copyFile);
        grunt.file.expandFiles("desktop/*.html").forEach(copyFile);
        grunt.file.expandFiles("mobile/*.html").forEach(copyFile);
        grunt.file.setBase(".");
    });

    //grunt.registerTask('prepare-statics', 'lint concat copy-html');
    grunt.registerTask('default', 'lint');
};
