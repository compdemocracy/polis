(ns replay-tail-test
  "Full-stream replay consumes the moderation tail; prefix replay does not."
  (:require [clojure.test :refer [deftest is]]))

(load-file "dev/replay.clj")

(def votes [{:t-ms 10 :pid 0 :tid 0 :sign -1}
            {:t-ms 20 :pid 1 :tid 0 :sign 1}
            {:t-ms 20 :pid 0 :tid 1 :sign 0}])
(def mods [{:modified 5 :tid 0 :mod 0 :is_meta false}
           {:modified 20 :tid 1 :mod 0 :is_meta false}
           {:modified 30 :tid 0 :mod -1 :is_meta false}
           {:modified 40 :tid 2 :mod 1 :is_meta true}])

(deftest full-stream-default-consumes-tail-once
  (let [steps (replay/slice-schedule votes [1 2 3] mods)]
    (is (= [[5] [20] [30 40]] (mapv #(mapv :modified (:mods %)) steps)))
    (is (= mods (vec (mapcat :mods steps)))))
  (is (= mods (:mods (first (replay/slice-schedule votes [3] mods))))))

(deftest prefix-diagnostic-keeps-historical-boundary
  (is (= [[5] [20] []]
         (mapv #(mapv :modified (:mods %))
               (replay/slice-schedule votes [1 2 3] mods "prefix-diagnostic"))))
  (is (= [5] (mapv :modified (:mods (first
        (replay/slice-schedule votes [1] mods "prefix-diagnostic")))))))

(deftest zero-vote-and-no-cut-boundaries
  (is (= mods (:mods (first (replay/slice-schedule [] [0] mods "full-stream")))))
  (is (= [] (:mods (first (replay/slice-schedule [] [0] mods "prefix-diagnostic")))))
  (is (= [] (replay/slice-schedule [] [] mods "full-stream"))))

(deftest vote-cursors-and-batches-do-not-move
  (let [plain (replay/slice-schedule votes [1 2 3])
        full (replay/slice-schedule votes [1 2 3] mods "full-stream")]
    (is (= plain (mapv #(assoc % :mods []) full)))
    (is (= [10 20 20] (mapv :cut-time-ms full)))))

(deftest captured-final-state-is-unchanged
  (let [steps (replay/final-state-steps votes [1 2 3] mods)]
    (is (= [[] [] mods] (mapv :mods steps)))
    (is (= [1 2 3] (mapv :cut-slot steps)))))
