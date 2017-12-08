;; Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(defproject polismath "0.1.0-SNAPSHOT"
  :source-paths ["src/"
                 ;; TODO Need to replace .lein-git-deps with proper checkouts
                 ".lein-git-deps/debug-repl/src/"
                 ".lein-git-deps/tools.cli/src/main/clojure/"]
  ; faster run time in exchange for slower startup time
  ;:aot :all
  ;:jvm-opts ^:replace []
  :repl-options {:timeout 120000
                 :port 34344}
  :target-path "target/%s"
  :javac-target "1.7"
  :repositories {"twitter4j" "http://twitter4j.org/maven2"}
  :plugins [[lein-git-deps "0.0.1-SNAPSHOT"]]
            ;; need to add profiles to use this to avoid clout dep issue
            ;[lein-gorilla "0.3.4"]
            ;[lein-environ "0.4.0"]

  :git-dependencies [["https://github.com/metasoarous/tools.cli.git" "master"]
                     ["https://github.com/GeorgeJahad/debug-repl.git" "master"]]
  :dependencies [;; org.clojure stuff...
                 [org.clojure/clojure "1.9.0-RC2"]
                 [org.clojure/spec.alpha "0.1.143"]
                 [org.clojure/core.async "0.2.395"]
                 [org.clojure/data.csv "0.1.3"]
                 [org.clojure/math.numeric-tower "0.0.4"]
                 [org.clojure/core.match "0.2.2"]
                 [org.clojure/tools.namespace "0.2.10"]
                 [org.clojure/tools.logging "0.3.1"]
                 [org.clojure/tools.trace "0.7.9"]
                 [org.clojure/tools.reader "0.10.0"]
                 ;; Other stuff
                 [commons-collections/commons-collections "3.2.1"]
                 [cheshire "5.6.3"]
                 [com.taoensso/timbre "4.7.4"]
                 ;; Troublesome carmine... was using this for simulation stuff
                 ;[com.taoensso/carmine "2.7.0" :exclusions [org.clojure/clojure]]
                 ;; Updates; requires fixing index conflict between named-matrix and core.matrix
                 [net.mikera/core.matrix "0.57.0"]
                 [net.mikera/vectorz-clj "0.45.0"]
                 ;[net.mikera/core.matrix "0.23.0"]
                 [net.mikera/core.matrix.stats "0.7.0"]
                 [net.mikera/vectorz-clj "0.45.0"]
                 [criterium "0.4.4"]
                 [clj-http "3.4.1"]
                 ;; We should be able to switch back to this now that we aren't using storm
                 ;[org.clojure/tools.cli "0.3.1"]
                 ;; implicitly requires jetty, component and ring
                 [ring/ring-core "1.5.0" :exclusions [clj-time]]
                 [ring-jetty-component "0.3.1" :exclusions [clj-time]]
                 [ring-basic-authentication "1.0.5"]
                 [ring/ring-ssl "0.2.1"]
                 [bidi "2.0.14" :exclusions [prismatic/schema]]
                 ;; Taking out storm cause yeah...
                 ;[org.apache.storm/storm-core "0.9.2-incubating"]
                 [incanter "1.9.1" :exclusions [org.clojure/clojure
                                                ;; For some reason, our 3.1.0 code fails when we include this; probably
                                                ;; AOT compilation issues, because excluding monger doesn't help...
                                                incanter/incanter-mongodb]]
                 [bigml/sampling "3.1"]
                 [com.novemberain/monger "3.1.0"]
                 [amazonica "0.3.77" :exclusions [org.apache.httpcomponents/httpclient
                                                  org.apache.httpcomponents/httpcore]]
                                                  ;com.fasterxml.jackson.core/jackson-core]]
                 ;[com.fasterxml.jackson.core/jackson-core "2.5.3"]
                 ;[com.fasterxml.jackson.core/jackson-databind "2.5.3"]
                 ;[org.clojure/java.jdbc "0.7.0-alpha1"]
                 [org.postgresql/postgresql "9.2-1004-jdbc4"]
                 [korma "0.4.3"]
                 [clj-time "0.12.2"]
                 [clj-excel "0.0.1"]
                 [semantic-csv "0.1.0"]
                 [dk.ative/docjure "1.11.0"]
                 [prismatic/plumbing "0.5.3"]
                 [environ "1.1.0"]
                 [mount "0.1.10"]
                 [honeysql "0.8.2"]

                 [org.clojure/test.check "0.9.0"]]

  :gorilla-options {:keymap {"command:app:save" "alt+g alt+w"}
                    :port 989796}
  :main polismath.runner
  :min-lein-version "2.3.0"
  :profiles {:dev {:dependencies [[org.clojure/test.check "0.9.0"]]
                   :source-paths ["src" "dev"]
                   :env {:mongo-url "db/mongo.db"}}
             :production {:env {}}})

