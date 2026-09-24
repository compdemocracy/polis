(ns attribution-test
  "Compact observations preserve matrix alignment and actual warm-state categories."
  (:require [clojure.test :refer [deftest is]]
            [clojure.core.matrix :as matrix]
            [polismath.math.named-matrix :as nm]))
(load-file "dev/replay.clj")

(deftest folded-matrix-alignment-and-null
  (let [a (nm/named-matrix [4 2] [9 3] [[-1 nil] [0 1]])
        b (nm/named-matrix [2 4] [3 9] [[1 0] [nil -1]])
        c (nm/named-matrix [4 2] [9 3] [[-1 0] [0 1]])]
    (is (= (replay/attribution-fold a) (replay/attribution-fold b)))
    (is (not= (replay/attribution-fold a) (replay/attribution-fold c)))
    (is (not= (replay/attribution-label 4) (replay/attribution-label "4")))))

(deftest start-categories-on-real-vectorz
  (is (= ["padded-warm" "nonzero-warm"]
         (replay/attribution-start-kinds [(matrix/matrix [1.0]) (matrix/matrix [1.0 2.0 3.0])] 3 3)))
  (is (= ["zero-fallback" "missing-fallback"]
         (replay/attribution-start-kinds [(matrix/matrix [0.0])] 3 3)))
  (is (= ["not-computed" "not-computed"]
         (replay/attribution-start-kinds nil 0 0))))

(deftest observer-does-not-change-conversation-values
  (let [votes (mapv (fn [i] {:t-ms (+ 1000 i) :pid (quot i 4) :tid (mod i 4) :sign (dec (mod (+ i (quot i 4)) 3))}) (range 32))
        steps (replay/slice-schedule votes [16 32])
        plain (replay/run-once "public-fixture" [] steps)
        captured (binding [replay/*attribution?* true] (replay/run-once "public-fixture" [] steps))]
    ;; Clojure metadata is outside value equality and outside prep-main.
    (let [blobs (fn [results] (mapv (fn [[s c]] [s (replay/->plain (polismath.conv-man/prep-main c))]) results))]
      (is (= (blobs plain) (blobs captured))))
    (is (= [[1.0] [1.0]] (:replay/attribution-starts (meta (second (first captured))))))))

(deftest observer-errors-are-nonfatal
  (is (nil? (with-redefs [replay/write-attribution! (fn [& _] (throw (ex-info "private sink" {})))]
              (replay/safe-write-attribution! "unused" []))))
  (doseq [value [2 0.5 Double/NaN Double/POSITIVE_INFINITY]]
    (let [bad (nm/named-matrix [0] [0] [[value]])]
      (is (thrown-with-msg? clojure.lang.ExceptionInfo #"ATTRIBUTION_VOTE"
                           (replay/attribution-fold bad)))
      (is (nil? (with-redefs [replay/write-attribution! (fn [& _] (replay/attribution-fold bad))]
                  (replay/safe-write-attribution! "unused" [])))))))
