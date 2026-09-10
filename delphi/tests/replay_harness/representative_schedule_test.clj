;; Synthetic final-source-state replay controls; no production data.
(load-file "dev/replay.clj")
(require '[clojure.test :refer :all] '[cheshire.core :as json] '[clojure.java.io :as io])

(defn with-source [n f]
  (let [dir (.toFile (java.nio.file.Files/createTempDirectory "sample-replay-test-" (make-array java.nio.file.attribute.FileAttribute 0)))
        path (io/file dir "events.jsonl")
        meta (io/file dir "events.meta.json")
        votes (mapv (fn [i] {"ord" i "kind" "vote" "created" 1001 "pid" 1 "tid" 0 "vote" -1
                             "weight_x_32767" nil "src" {"table" "votes" "row" i}}) (range n))
        comments (mapv (fn [i] {"ord" (+ n i) "kind" "comment" "created" 900 "pid" 1 "tid" i
                                "modified" (when (zero? i) 9000) "mod" (if (zero? i) 0 -1) "is_meta" (= i 1)
                                "src" {"table" "comments" "row" i}}) (range 2))
        events (into votes comments)]
    (try
      (spit path (apply str (map #(str (json/generate-string %) "\n") events)))
      (spit meta (json/generate-string
                   {"schema_version" "certify-events/2" "polarity" {"storage_agree_value" -1}
                    "counts" {"events" (count events) "vote_events" n "comment_events" 2}
                    "logical_digest_sha256" (#'replay/sha256-hex
                       (apply str (map #(str (json/generate-string (into (sorted-map) (dissoc % "src"))) "\n") events)))}))
      (f (replay/read-event-stream path))
      (finally (.delete path) (.delete meta) (.delete dir)))))

(deftest captured-state-retains-late-and-unknown-timestamps
  (with-source 7
    (fn [input]
      (is (= [{:tid 0 :mod 0 :is_meta false :modified 9000}
              {:tid 1 :mod -1 :is_meta true :modified 0}] (:final-mods input)))
      ;; The established historical weaving mode remains unchanged.
      (is (= 1 (get-in input [:mods :n-skipped])))
      (is (= 1 (count (get-in input [:mods :events])))))))

(deftest final-checkpoint-only-across-tiny-empty-and-tied-streams
  (doseq [n [0 1 2 3 5 6 7 19]]
    (with-source n
      (fn [input]
        (let [votes (replay/build-dataset (:votes input))
              slots (vec (sort (set (map #(quot (+ (* % n) 5) 6) (range 1 7)))))
              steps (replay/final-state-steps votes slots (:final-mods input))]
          (is (= n (:cut-slot (peek steps))))
          (is (= n (reduce + (map (comp count :votes) steps))))
          (is (every? (comp empty? :mods) (butlast steps)))
          (is (= (:final-mods input) (:mods (peek steps)))))))))

(let [r (run-tests)] (System/exit (if (zero? (+ (:fail r) (:error r))) 0 1)))
