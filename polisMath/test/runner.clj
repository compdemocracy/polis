;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns runner
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
            [clojure.test :as test]))



(defn -main []
  "Run all the pure tests for polisapp. The one integration test is in conv-man-tests, and should be run separately (and
  needs to be cleaned up to run on a separate poller system)"
  ;(try
    (apply
      test/run-tests
      '[cluster-tests
        conversation-test
        index-hash-test
        named-matrix-test
        pca-test
        silhouette-test
        stats-test
        utils-test
        ptpt-stats-test]))
    ;(catch Exception e
    ;  (println "XXX Error executing tests!")
    ;  (.printStackTrace e))))

(-main)

;(test/run-tests 'conversation-test)
