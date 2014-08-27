(defproject org.clojure/newtools.cli "0.3.2-SNAPSHOT"
  :description "Command line arguments library, renamespaced such that it won't conflict with storm."
  :parent [org.clojure/pom.contrib "0.1.2"]
  :url "https://github.com/metasoarous/tools.cli"
  :license {:name "Eclipse Public License"
            :url "http://www.eclipse.org/legal/epl-v10.html"}
  :source-paths ["src/main/clojure"]
  :test-paths ["src/test/clojure"]
  :repositories {"sonatype-oss-public" "https://oss.sonatype.org/content/groups/public/"}
  :dependencies [[org.clojure/clojure "1.6.0"]]
  :profiles {:1.2 {:dependencies [[org.clojure/clojure "1.2.1"]]}
             :1.3 {:dependencies [[org.clojure/clojure "1.3.0"]]}
             :1.4 {:dependencies [[org.clojure/clojure "1.4.0"]]}
             :1.5 {:dependencies [[org.clojure/clojure "1.5.1"]]}
             :1.6 {:dependencies [[org.clojure/clojure "1.6.0"]]}

  :aliases {"test-all" ["with-profile" "test,1.2:test,1.3:test,1.4:test,1.5:test,1.6" "test"]
            "check-all" ["with-profile" "1.2:1.3:1.4:1.5:1.6" "check"]}
  :min-lein-version "2.0.0")
