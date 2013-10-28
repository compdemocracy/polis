(defproject polis-storm "0.1.0-SNAPSHOT"
  :source-paths ["src/"]
  :aot :all
  :repositories {"twitter4j" "http://twitter4j.org/maven2"}
  :dependencies [[commons-collections/commons-collections "3.2.1"]
                 [aleph "0.3.0-rc2"]
                 [org.clojure/data.json "0.2.2"]
                 [lamina "0.5.0"]
                 [gloss "0.2.2"]
                 [org.clojure/math.numeric-tower "0.0.2"]
                 [incanter "1.5.4"]]
  :profiles {:dev {:dependencies [[org.clojure/tools.trace "0.7.6"]
                                  [storm "0.8.2"]
                                  [org.clojure/clojure "1.4.0"]]}}
  :min-lein-version "2.3.0")

