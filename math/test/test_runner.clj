;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns test-runner
  (:require [cluster-tests]
            [conv-man-tests]
            [conversation-test]
            [index-hash-test]
            [named-matrix-test]
            [pca-test]
            [silhouette-test]
            [stats-test]
            [utils-test]
            [ptpt-stats-test]
            [pythonport-test]
            [clojure.test :as test]
            [clojure.string :as str]))

(def all-test-namespaces
  '[cluster-tests
    conversation-test
    index-hash-test
    named-matrix-test
    pca-test
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

(defn -main
  "Run tests for polisapp. If no arguments are provided, runs all tests.
   Otherwise, runs only the specified test namespaces.
   
   Usage:
     clojure -M -m test-runner          # run all tests
     clojure -M -m test-runner utils    # run only utils-test
     clojure -M -m test-runner utils pythonport  # run utils-test and pythonport-test
   
   Note: The integration test in conv-man-tests should be run separately as it
   needs to be cleaned up to run on a separate poller system."
  [& args]
  (let [test-namespaces (parse-test-names args)]
    (println "Running tests:" (str/join ", " test-namespaces))
    (apply test/run-tests test-namespaces)))

;(-main)
;(test/run-tests 'conversation-test)
