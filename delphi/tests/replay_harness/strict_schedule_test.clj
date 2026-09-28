;; From math/: clojure -M ../delphi/tests/replay_harness/strict_schedule_test.clj
(load-file "dev/replay.clj")
(require '[clojure.test :refer :all])

(def votes [{:t-ms 10 :pid 1 :tid 1 :sign 1}
            {:t-ms 20 :pid 2 :tid 1 :sign -1}])

(deftest explicit-zero-checkpoint
  (let [slots (replay/resolve-cut-slots [] {"mode" "vote-count" "at" [0] "empty_checkpoint" true})
        steps (replay/slice-schedule [] slots)]
    (is (= [0] slots))
    (is (= [{:index 0 :prev-slot 0 :cut-slot 0 :votes [] :mods [] :cut-time-ms 0}] steps))))

(deftest undeclared-zero-rejected
  (is (thrown-with-msg? Exception #"empty_checkpoint"
        (replay/resolve-cut-slots [] {"mode" "vote-count" "at" ["end"]}))))

(deftest duplicate-rejected
  (is (thrown-with-msg? Exception #"duplicate"
        (replay/resolve-cut-slots votes {"mode" "vote-count" "at" [1 1 2]}))))

(deftest duplicate-opt-in
  (is (= [1 2] (replay/resolve-cut-slots votes
                {"mode" "vote-count" "at" [1 1 2] "deduplicate" true}))))

(deftest out-of-order-rejected-even-with-opt-in
  (is (thrown-with-msg? Exception #"increasing"
        (replay/resolve-cut-slots votes
          {"mode" "vote-count" "at" [1 2 1] "deduplicate" true}))))

(deftest zero-before-positive-preserves-batches
  (let [steps (replay/slice-schedule votes [0 1 2])]
    (is (= [[] [(first votes)] [(second votes)]] (mapv :votes steps)))
    (is (= [0 10 20] (mapv :cut-time-ms steps)))))

(let [{:keys [fail error]} (run-tests)]
  (shutdown-agents)
  (System/exit (if (zero? (+ fail error)) 0 1)))
