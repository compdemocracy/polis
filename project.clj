(defproject polis-storm "0.1.0-SNAPSHOT"
  :source-paths ["src"]
  :java-source-paths ["src/jvm"]
  :resource-paths ["multilang"]
  :aot :all
  :repositories {
;;                 "twitter4j" "http://twitter4j.org/maven2"
                 }

  :dependencies [
                   [commons-collections/commons-collections "3.2.1"]
                   [aleph "0.3.0-rc2"]
                   [org.clojure/data.json "0.2.2"]
                   [storm "0.8.2"]   
                 ]

  :profiles {:dev
              {:dependencies [
                              [org.clojure/clojure "1.4.0"]]}}
  :min-lein-version "2.0.0"
  )
