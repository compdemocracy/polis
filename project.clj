;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(defproject polismath "0.1.0-SNAPSHOT"
  :source-paths ["src/"]
  ;; TODO Need to replace .lein-git-deps with proper checkouts
  ; faster run time in exchange for slower startup time
  ;:aot :all
  ;:jvm-opts ^:replace []
  :jvm-opts ["-Xmx4g"]
  :repl-options {:timeout 220000
                 ;:nrepl-middleware [com.gfredericks.debug-repl/wrap-debug-repl]
                 :port 34344}
  :target-path "target/%s"
  :javac-target "1.7"
  :repositories {"twitter4j" "https://twitter4j.org/maven2"}
  :plugins [];; need to add profiles to use this to avoid clout dep issue
            ;[lein-gorilla "0.4.0"]
            ;[cider/cider-nrepl "0.16.0"]]
            ;[lein-environ "0.4.0"]

  :git-dependencies [["https://github.com/GeorgeJahad/debug-repl.git" "master"]]
  :dependencies [;; org.clojure stuff...
                 [org.clojure/clojure "1.10.0"]
                 [org.clojure/spec.alpha "0.2.176"]
                 [org.clojure/core.async "0.4.490"]
                 [org.clojure/data.csv "0.1.4"]
                 [org.clojure/math.numeric-tower "0.0.4"]
                 [org.clojure/core.match "0.2.2"]
                 [org.clojure/tools.namespace "0.2.10"]
                 [org.clojure/tools.logging "0.4.1"]
                 [org.clojure/tools.trace "0.7.10"]
                 [org.clojure/tools.reader "1.3.2"]

                 [org.flatland/ordered "1.5.7"] 
                 ;; Other stuff
                 [commons-collections/commons-collections "20040616"]
                 [cheshire "5.8.1"]
                 [com.taoensso/timbre "4.10.0"]
                 ;; Troublesome carmine... was using this for simulation stuff
                 ;[com.taoensso/carmine "2.7.0" :exclusions [org.clojure/clojure]]
                 ;; Updates; requires fixing index conflict between named-matrix and core.matrix
                 [net.mikera/core.matrix "0.62.0"]
                 [net.mikera/vectorz-clj "0.48.0"]
                 ;[net.mikera/core.matrix "0.23.0"]
                 [net.mikera/core.matrix.stats "0.7.0"]
                 [net.mikera/vectorz-clj "0.48.0"]
                 [criterium "0.4.4"]
                 [clj-http "3.9.1"]
                 ;; We should be able to switch back to this now that we aren't using storm
                 [org.clojure/tools.cli "0.4.1"]
                 ;; implicitly requires jetty, component and ring
                 [ring/ring-core "1.7.1" :exclusions [clj-time]]
                 [ring-jetty-component "0.3.1" :exclusions [clj-time]]
                 [ring-basic-authentication "1.0.5"]
                 [ring/ring-ssl "0.3.0"]
                 [bidi "2.1.5" :exclusions [prismatic/schema]]
                 ;; Taking out storm cause yeah...
                 ;[org.apache.storm/storm-core "0.9.2-incubating"]
                 [incanter "1.9.3" :exclusions [org.clojure/clojure]]
                 [bigml/sampling "3.2"]
                 [amazonica "0.3.139" :exclusions [org.apache.httpcomponents/httpclient
                                                   org.apache.httpcomponents/httpcore]]
                                                  ;com.fasterxml.jackson.core/jackson-core]]
                 ;[com.fasterxml.jackson.core/jackson-core "2.5.3"]
                 ;[com.fasterxml.jackson.core/jackson-databind "2.5.3"]
                 ;[org.clojure/java.jdbc "0.7.0-alpha1"]
                 [org.postgresql/postgresql "42.2.5"]
                 [korma "0.4.3"]
                 [clj-time "0.15.1"]
                 [clj-excel "0.0.1"]
                 [semantic-csv "0.2.0"]
                 ;[dk.ative/docjure "1.13.0"]
                 [prismatic/plumbing "0.5.5"]
                 [environ "1.1.0"]
                 [mount "0.1.15"]
                 [honeysql "0.9.4"]
                 [metasoarous/oz "1.6.0-alpha3"]

                 ;; Dev
                 [org.clojure/test.check "0.9.0"]
                 ;[com.gfredericks/debug-repl "0.0.9"]
                 [irresponsible/tentacles "0.6.3"]]

  :gorilla-options {:keymap {"command:app:save" "alt+g alt+w"}
                    :port 989796}
  :main ^:skip-aot polismath.runner
  :min-lein-version "2.3.0"
  :profiles {:dev {:dependencies []
                   :source-paths ["src" "dev"]}
             :production {:env {}}})

