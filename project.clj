(defproject polismath "0.1.0-SNAPSHOT"
  :source-paths ["src/"
                 "src/polismath/"
                 ".lein-git-deps/debug-repl/src/"
                 ".lein-git-deps/tools.cli/src/main/clojure/"]
  ;:aot :all
  ; faster run time in exchange for slower startup time
  :jvm-opts ^:replace []
  :javac-target "1.7"
  :repositories {"twitter4j" "http://twitter4j.org/maven2"}
  :plugins [[lein-git-deps "0.0.1-SNAPSHOT"]
            [lein-environ "0.4.0"]]
  :git-dependencies [
    ["https://github.com/Prismatic/hiphip.git" "master"]
    ["https://github.com/metasoarous/tools.cli.git" "master"]
  ]
  :dependencies [[commons-collections/commons-collections "3.2.1"]
                 [cheshire "5.3.1"]
                 [org.clojure/tools.reader "0.8.4"]
                 [com.taoensso/timbre "3.1.6"]
                 [net.mikera/core.matrix "0.23.0"]
                 [net.mikera/core.matrix.stats "0.3.0"]
                 [net.mikera/vectorz-clj "0.19.0"]
                 [org.clojure/data.csv "0.1.2"]
                 [org.clojure/math.numeric-tower "0.0.4"]
                 [org.clojure/core.match "0.2.1"]
                 ;[org.clojure/tools.cli "0.3.1"]
                 [storm "0.9.0.1"]
                 [bigml/sampling "2.1.0"]
                 [incanter "1.5.4"]
                 [com.novemberain/monger "1.5.0"]
                 [org.postgresql/postgresql "9.2-1004-jdbc4"]
                 [korma "0.3.0-RC5"]
                 [clj-time "0.6.0"]
                 [prismatic/plumbing "0.2.0"]
                 [environ "0.4.0"]]
  :min-lein-version "2.3.0"
  
  :profiles {
    :dev {
      ;:global-vars {
        ;*warn-on-reflection* true
      ;}
      :dependencies [
        [org.clojure/tools.trace "0.7.6"]
        [criterium "0.4.2"]
        [org.clojure/clojure "1.5.1"]
      ]
      :git-dependencies [
        ["https://github.com/GeorgeJahad/debug-repl.git" "master"]
      ]
      :env {
        :mongo-url "db/mongo.db"
      }
    }
    :production {
      :dependencies [
        [org.clojure/tools.trace "0.7.6"]
        [criterium "0.4.2"]
        [org.clojure/clojure "1.5.1"]
      ]
      :env {
      }
    }
  }
)

