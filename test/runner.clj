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
  ;(try
    (apply
      test/run-tests
      '[cluster-tests
        conv-man-tests
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
