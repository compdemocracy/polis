var fs    = require('fs'),
    path  = require('path'),
    bower = require('bower');

module.exports = function (grunt) {
  grunt.registerTask('ensure-installed', function() {
    var complete = this.async();
    if (!fs.existsSync(path.join(__dirname, '..', 'bower_components'))) {
      bower.commands.install().on('data', function(data) {
        process.stdout.write(data);
      }).on('error', function(data) {
        process.stderr.write(data);
      }).on('end', function (data) {
        if (data) {
          process.stdout.write(data);
        }
        complete();
      });
    } else {
      complete();
    }
  });
}
