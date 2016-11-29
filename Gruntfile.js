// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

module.exports = function(grunt) {
  grunt.option('stack', true);

  var port = process.env.PORT || 8000,
      hostname = 'localhost',
      templates = {},
      paths = {
        'public': 'public',
        output: {
          js: 'public/js',
          css: 'public/css',
          font: 'public/font',
          templates: 'public/templates'
        },
        js: 'js',
        css: 'css',
        templates: 'js/templates',
        views: 'js/views',
        models: 'js/models',
        collections: 'js/collections'
      };

  // Register required tasks
  grunt.loadTasks('tasks');
  grunt.loadNpmTasks('thorax-inspector');
  grunt.loadNpmTasks('grunt-contrib-less');
  grunt.loadNpmTasks('grunt-contrib-requirejs');
  grunt.loadNpmTasks('grunt-contrib-jshint');
  require('matchdep').filterDev('grunt-*').forEach(function(task) {
    if (task !== 'grunt-cli') {
      grunt.loadNpmTasks(task);
    }
  });

  // ******from http://gruntjs.com/configuring-tasks:******
  // All most people need to know is that foo/*.js
  // will match all files ending with .js in the foo/ subdirectory,
  // but foo/**/*.js will match all files
  // ending with .js in the foo/ subdirectory and all of its subdirectories.
  // ******from http://gruntjs.com/configuring-tasks:******



  grunt.config.init({
    pkg: grunt.file.readJSON('package.json'),
    paths: paths,
    clean: {
      output: [           //DELETE EVERYTHING IN THE
        paths.output.js,  //public/js folder
        paths.output.css,  //and the public/css folder
        paths.output.font
      ]
    },
    copy: {
      html: {
        files: [
        {
          src: 'index.html',
          dest: 'public/index.html'
        }
        ]
      },
      conditional_js: {
        files: [
          {
            src: 'bower_components/d3/d3.js',
            dest: 'public/js/d3.js',
          }, {
            src: 'bower_components/r2d3/r2d3.js',
            dest: 'public/js/r2d3.js',
          },
        ]
      },
      requirejs: {
        files: [
          {
            src: 'bower_components/requirejs/require.js',
            dest: 'public/js/require.js'
          }
        ]
      },
      fontawesome: {
        files: [
          {
            expand: true,
            cwd: 'bower_components/font-awesome/font/',
            src: '*',
            dest: 'public/font/',
            flatten: true,
            filter: 'isFile'
          }
        ]
      },
      styles: {
        files: [
          {
            expand: true,
            cwd: paths.css,
            src: '**/*.css',
            dest: paths.output.css
          }
        ]
      }
    },
    less: {
      development: {
        files: [
          {src: ['css/polis_main.less'], dest: 'public/css/lib/polis_main.css'}
        ]
      },
      production: {
        options: {
          yuicompress: true,
          report: 'gzip'
        },
        files: [
          {src: ['css/polis_main.less'], dest: 'public/css/lib/polis_main.css'}
        ]
      }
    },
    connect: {
      development: {
        options: {
          hostname: hostname,
          base: paths.public,
          port: port
        }
      },
      production:  {
        options: {
          hostname: hostname,
          base: paths.public,
          port: port,
          keepalive: true
        }
      }
    },
    thorax: {
      inspector: {
        editor: 'subl',
        background: true,
        paths: {
          views: paths.views,
          models: paths.models,
          collections: paths.collections,
          templates: paths.templates
        }
      }
    },
    requirejs: {
      development: getRequireJSOptions('development'),
      production: getRequireJSOptions('production')
    },
    handlebars: {
      templates: {
        options: {
          namespace: false,
          amd: true
        }
      }
    },
    watch: {
      handlebars: {
        files: ['js/templates/**/*'], //when any of these files change
        tasks: ['templates', 'scripts:development']          //these tasks are run.
      },
      scripts: {
        files: ['js/**/*.js'],
        tasks: ['scripts:development']
      },
      styles: {
        files: ['css/**/*'],
        tasks: ['copy:styles', 'less:development']
      }
    },
    jshint: {
        files:['js/**/*.js', '!js/lib/jquery*'],
        // configure JSHint (documented at http://www.jshint.com/docs/)
        options: {
         // reporter: 'jslint',
          curly: true, // require if,else blocks to have {}
          eqeqeq: true,
          trailing: true, // no trailing whitespace allowed
          // immed: true,
          // latedef: true,
          // newcap: true,
          // noarg: true,
          // sub: true,
          // undef: true,
        //  unused: true,
          quotmark: "double",
         // plusplus: true, // no ++ or --
        //  nonew: true,
          noarg: true, // no arguments.caller and arguments.callee (allow for optimizations)
          newcap: true, // constructors must be capitalized
        //  latedef: "nofunc",
         // indent: 2,
          immed: true,
//          forin: true, require hasOwnProperty checks
          boss: true,
//          debug: true, // uncomment temporarily when you want to allow debugger; statements.
          // browser: true,
          es3: true,
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
          // relax: eventually we should get rid of these
            //expr: true,
           // loopfunc: true,
            //shadow: true,
        }
    }
  });

  // for an explanation of the getRequireJSOptions function, see:
  // https://github.com/jrburke/r.js/blob/master/build/example.build.js

  function getRequireJSOptions(env) {
    var options = {
      appDir: paths.js,
      baseUrl: './',
      dir: paths.output.js,
      modules: [
        {
          name: 'main'
        }
      ],
      paths: {
        'jquery': 'lib/jquery', // Note: these jquery files were generated from this fork: https://github.com/mbjorkegren/jquery/tree/1.9-callbacks-array-fix
        'underscore': '../bower_components/underscore/underscore',
        'originalhandlebars': '../bower_components/handlebars/handlebars.runtime', //original handlebars
        'handlebars': 'templates/helpers/handlebarsWithHelpers', //this one has polis custom template helpers
        'originalbackbone': '../bower_components/backbone/backbone', // backbone before modifications
        'backbone': 'net/backbonePolis', // polis-specific backbone modifications
        'thorax': '../bower_components/thorax/thorax',
        'bootstrap_alert': '../bower_components/bootstrap/js/alert',
        'bootstrap_tab': '../bower_components/bootstrap/js/tab',
        'bootstrap_tooltip': '../bower_components/bootstrap/js/tooltip',
        'bootstrap_popover': '../bower_components/bootstrap/js/popover',
        'bootstrap_button': '../bower_components/bootstrap/js/button',
        'bootstrap_transition': '../bower_components/bootstrap/js/transition',
        'bootstrap_collapse': '../bower_components/bootstrap/js/collapse',
        'bootstrap_dropdown': '../bower_components/bootstrap/js/dropdown',
        'bootstrap_affix': '../bower_components/bootstrap/js/affix',
        // d3 is conditionally loaded from index
        // 'd3': '../bower_components/d3/d3',
        'lawnchair': '../bower_components/lawnchair/src/Lawnchair',
        // 'app': 'lib/App',
        'p': 'lib/p',
        'polis': 'lib/polis',
        'VisView': 'lib/VisView',
        'd3tooltips': '../bower_components/d3-tip/index'
      },
      shim: {
        'originalhandlebars': {
          exports: 'Handlebars'
        },
        'originalbackbone': {
          exports: 'Backbone',
          deps: ['jquery', 'underscore']
        },
        'underscore': {
          exports: '_'
        },
        'thorax': {
          exports: 'Thorax',
          deps: ['handlebars', 'backbone']
        },
        'bootstrap_alert': {  //all bootstrap files need to be added to the dependency array of js/main.js
          deps: ['jquery']
        },
        'bootstrap_tab': {
          deps: ['jquery']
        },
        'bootstrap_tooltip': {
          deps: ['jquery']
        },
        'bootstrap_button': {
          deps: ['jquery']
        },
        'bootstrap_transition': {
          deps: ['jquery']
        },
        'anystretch': {
          deps: ['jquery']
        },
        'net/bbFetch': {
          exports: 'bbFetch',
          deps: ['jquery', 'underscore'],
        },
        'net/bbSave': {
          exports: 'bbSave',
          deps: ['jquery', 'underscore'],
        },
        'net/bbDestroy': {
          exports: 'bbDestroy',
          deps: ['jquery', 'underscore'],
        },
        'VisView': {
          exports: 'VisView',
          deps: ['d3tooltips']
        }
      }
    };
    if (env === 'production') {
      /*
      TODO
      options.keepBuildDir = true;
      options.optimize = 'uglify';
      */
    }
    if (env === 'development') {
      options.keepBuildDir = true;
      options.optimize = 'none';
      options.uglify2 = {
        compress: {
          dead_code: true,
          unused: true,
        }
      }
    }
    return {
      options: options
    };
  }

  grunt.registerTask('open-browser', function () {
    var open = require('open');
    open('http://' + hostname + ':' + port);
  });

  grunt.registerTask('html:development', [
    'copy:html',
  ]);

  grunt.registerTask('html:production', [
    'copy:html',
  ]);

  grunt.registerTask('copyfontawesome', [
    'copy:fontawesome',
  ]);

  grunt.registerTask('scripts:development', [
    'copy:requirejs',
    'copy:conditional_js',
    'requirejs:development'
  ]);

  grunt.registerTask('scripts:production', [
    'copy:requirejs',
    'copy:conditional_js',
    'requirejs:production'
  ]);

  grunt.registerTask('update-templates-list', function() {
    // Set up the templates object for Handlebars
    grunt.file.glob.sync(paths.templates + '/**/*.{handlebars,hbs}').forEach(function (file) {
      var target = paths.output.js + '/templates' + file.substr(paths.templates.length).replace(/\.(?:handlebars|hbs)$/, '.js');
      templates[target] = file;
    });
    grunt.config.set('handlebars.templates.files', templates);
  });

  grunt.registerTask('create-output-directories', function() {
    grunt.file.mkdir('public/js');
    grunt.file.mkdir('public/css');
    grunt.file.mkdir('public/css/lib'); //for the third part libray css builds
    grunt.file.mkdir('public/font'); //for fontawesome fonts
  });

  grunt.registerTask('templates', [
    'update-templates-list',
    'handlebars:templates'
  ]);

  grunt.registerTask('styles', [
    'copy:styles',
    'less:development'
  ]);

  grunt.registerTask('default', [
    'jshint',
    'ensure-installed',
    'clean:output',
    'create-output-directories',
    'styles',
    'templates',
    'copyfontawesome',
    'html:development',
    'scripts:development',
    'thorax:inspector',
    'connect:development',
 //   'open-browser',
    'watch'
  ]);

  grunt.registerTask('production', [
    'jshint',
    'clean:output',
    'create-output-directories',
    'styles',
    'templates',
    'html:production',
    'scripts:production',
//    'open-browser',
    'connect:production',
  ]);
};
