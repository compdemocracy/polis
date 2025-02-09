;; Copyright (C) 2012-present, The Authors. This program is free software: you
;can redistribute it and/or  modify it under the terms of the GNU Affero General
;Public License, version 3, as published by the Free Software Foundation. This
;program is distributed in the hope that it will be useful, but WITHOUT ANY
;WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
;PARTICULAR PURPOSE.  See the GNU Affero General Public License for more
;details. You should have received a copy of the GNU Affero General Public
;License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns test-runner
  (:require [cluster-tests]
            ;[conv-man-tests]
            [conversation-test]
            [index-hash-test]
            [named-matrix-test]
            [pca-test]
            [language-test]
            [silhouette-test]
            [stats-test]
            [utils-test]
            [ptpt-stats-test]
            [pythonport-test]
            [clojure.test :as test]
            [clojure.string :as str]
            [cloverage.coverage :as cov]))

(def all-test-namespaces
  '[cluster-tests
    conversation-test
    index-hash-test
    named-matrix-test
    pca-test
    language-test
    silhouette-test
    stats-test
    utils-test
    ptpt-stats-test
    pythonport-test])

(defn parse-test-names
  "Convert command line args into test namespace symbols.
   Each arg should be the name of a test namespace without the '-test' suffix.
   e.g., 'utils' will run utils-test"
  [args]
  (if (empty? args)
    all-test-namespaces
    (mapv #(symbol (str % "-test")) args)))

(defn test-to-src-ns
  "Convert a test namespace to its corresponding source namespace pattern.
   e.g., 'utils-test -> polismath.utils.*
         'pca-test -> polismath.math.pca.*
         'language-test -> nil (no source namespace)"
  [test-ns]
  (let [base-name (str/replace (name test-ns) #"-tests?$" "")]
    (cond
      (= base-name "language") nil ; Special case - no source namespace
      (contains? #{"pca" "named-matrix" "clusters" "stats" "conversation"} base-name)
        (re-pattern (str "^polismath\\.math\\." (str/replace base-name #"-" "-") ".*"))
      :else
        (re-pattern (str "^polismath\\." base-name ".*")))))

(defn run-with-coverage [test-namespaces debug?]
  (cov/run-project
    (merge
      {:src-ns-path ["src"]
       :test-ns-path ["test"]
       :ns-regex (->> test-namespaces 
                     (map test-to-src-ns)
                     (remove nil?)    ; Remove nil entries
                     (seq))           ; Convert to sequence or nil if empty
       :exclude-namespaces ["polismath.conv-man" "conv-man-tests"]
       :test-ns-regex (map #(re-pattern (str "^" %)) test-namespaces)
       :output "target/coverage"
       :low-watermark 50
       :high-watermark 80
       :fail-threshold 0}
      (when debug?
        {:debug true}))))

(defn -main
  "Run tests for polisapp. If no arguments are provided, runs all tests.
   Otherwise, runs only the specified test namespaces.
   
  Usage:
    clojure -M -m test-runner          # run all tests
    clojure -M -m test-runner utils    # run only utils-test
    clojure -M -m test-runner --coverage  # run all tests with coverage
    clojure -M -m test-runner --coverage --debug  # run all tests with debug coverage
    clojure -M -m test-runner utils pythonport --coverage  # run utils-test and pythonport-test with coverage

  Note: The integration test in conv-man-tests should be run separately as it
  needs to be cleaned up to run on a separate poller system."
  [& args]
  (let [coverage? (some #{"--coverage"} args)
        debug? (some #{"--debug"} args)
        test-args (remove #{"--coverage" "--debug"} args)
        test-namespaces (parse-test-names test-args)
        ; Check if there are any source namespaces to monitor
        has-source-ns? (->> test-namespaces
                           (map test-to-src-ns)
                           (remove nil?)
                           seq)]
    (println "Running tests:" (str/join ", " test-namespaces))
    (if (and coverage? has-source-ns?)
      (run-with-coverage test-namespaces debug?)
      (apply test/run-tests test-namespaces))))

;(-main)
;(test/run-tests 'conversation-test)
