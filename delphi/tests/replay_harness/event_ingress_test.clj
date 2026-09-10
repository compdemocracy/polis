;; From math/: clojure -M ../delphi/tests/replay_harness/event_ingress_test.clj
(load-file "dev/replay.clj")
(require '[clojure.test :refer :all] '[cheshire.core :as json] '[clojure.java.io :as io])

(def vote-events [{"ord" 0 "kind" "vote" "created" 1001 "pid" 1 "tid" 2 "vote" -1
                   "weight_x_32767" 0 "src" {"table" "votes" "row" 0}}
                  {"ord" 1 "kind" "vote" "created" 1001 "pid" 1 "tid" 2 "vote" 1
                   "weight_x_32767" nil "src" {"table" "votes" "row" 1}}
                  {"ord" 2 "kind" "vote" "created" 1999 "pid" 1 "tid" 2 "vote" nil
                   "weight_x_32767" 123 "src" {"table" "votes" "row" 2}}])

(defn with-stream [events sign f]
  (let [dir (.toFile (java.nio.file.Files/createTempDirectory "ingress-test-" (make-array java.nio.file.attribute.FileAttribute 0)))
        path (io/file dir "events.jsonl")
        meta (io/file dir "events.meta.json")]
    (try
      (spit path (apply str (map #(str (json/generate-string %) "\n") events)))
      (spit meta (json/generate-string
                   {"schema_version" "certify-events/2" "polarity" {"storage_agree_value" sign}
                    "counts" {"events" (count events) "vote_events" (count events) "comment_events" 0}
                    "logical_digest_sha256" (#'replay/sha256-hex
                       (apply str (map #(str (json/generate-string (into (sorted-map) (dissoc % "src"))) "\n") events)))}))
      (f path)
      (finally (.delete path) (.delete meta) (.delete dir)))))

(deftest millisecond-null-weight-and-tie-order
  (with-stream vote-events -1
    (fn [path]
      (let [votes (:votes (replay/read-event-stream path))]
        (is (= [1001 1001 1999] (mapv :t-ms votes)))
        (is (= [1 -1 nil] (mapv :sign votes)))
        (is (= [0 nil 123] (mapv :weight_x_32767 votes)))
        (is (= [0 1 2] (mapv :source-ord votes)))
        (is (= [{:pid 1 :tid 2 :vote -1 :created 1001 :weight_x_32767 0}
                {:pid 1 :tid 2 :vote 1 :created 1001 :weight_x_32767 nil}
                {:pid 1 :tid 2 :vote nil :created 1999 :weight_x_32767 123}]
               (replay/->conv-votes votes)))))))

(deftest corrupt-events-rejected
  (doseq [events [(assoc-in vote-events [1 "ord"] 0)
                  (assoc-in vote-events [0 "vote"] false)
                  (assoc-in vote-events [0 "weight_x_32767"] false)
                  (assoc-in vote-events [1 "created"] 999)
                  (assoc-in vote-events [0 "src" "row"] 3)
                  (assoc-in vote-events [0 "pid"] 1.5)
                  (assoc-in vote-events [0 "vote"] 2)]]
    (with-stream events -1 #(is (thrown? Exception (replay/read-event-stream %))))))

(deftest bad-conventions-rejected
  (doseq [s [true nil 0 -1.0 "-1"]]
    (with-stream vote-events s #(is (thrown? Exception (replay/read-event-stream %))))))

(deftest duplicate-json-rejected
  (is (thrown? Exception (replay/parse-event-json "{\"ord\":0,\"ord\":0}"))))

(deftest zero-events-retained
  (with-stream [] -1 #(is (= [] (:votes (replay/read-event-stream %))))))

(let [r (run-tests)] (System/exit (if (zero? (+ (:fail r) (:error r))) 0 1)))
