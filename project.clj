(defproject polis-storm "0.1.0-SNAPSHOT"
  :source-paths ["src/"
                 ".lein-git-deps/debug-repl/src/"]
  ;:aot :all
  ; faster run time in exchange for slower startup time
  :jvm-opts ^:replace []
  :repositories {"twitter4j" "http://twitter4j.org/maven2"}
  :plugins [[lein-git-deps "0.0.1-SNAPSHOT"]
            [lein-environ "0.4.0"]]
  :git-dependencies [["https://github.com/Prismatic/hiphip.git" "master"]
                     ["https://github.com/GeorgeJahad/debug-repl.git" "master"]]
  :dependencies [[commons-collections/commons-collections "3.2.1"]
                 [aleph "0.3.0-rc2"]
                 [org.clojure/data.json "0.2.2"]
                 [lamina "0.5.0"]
                 [gloss "0.2.2"]
                 [net.mikera/core.matrix "0.19.0"]
                 [net.mikera/core.matrix.stats "0.3.0"]
                 [net.mikera/vectorz-clj "0.19.0"]
                 [org.clojure/data.csv "0.1.2"]
                 [org.clojure/math.numeric-tower "0.0.2"]
                 [storm "0.8.2"]
                 [incanter "1.5.4"]
                 [com.novemberain/monger "1.5.0"]
                 [org.postgresql/postgresql "9.2-1004-jdbc4"]
                 [korma "0.3.0-RC5"]
                 [clj-time "0.6.0"]
                 [environ "0.4.0"]]
  :profiles {:dev {:dependencies [[org.clojure/tools.trace "0.7.6"]
                                  [criterium "0.4.2"]
                                  [org.clojure/clojure "1.5.1"]]}
             :env {:dev-mongolab-uri "db/mongo.db"}}
  :min-lein-version "2.3.0")

