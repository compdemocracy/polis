;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns stage-json-test
  "Unit tests for the --stage-json emitter in dev/replay.clj (R-ORACLE,
  P-030 §2.3).

  The driver lives under dev/ and is loaded by the :replay alias with `-i`
  rather than being on the classpath (deps.edn comments why: dev/user.clj would
  be auto-loaded and it requires oz/cider, which are not base deps). So this
  namespace load-files it, exactly as the alias does, relative to math/ — the
  directory `clojure -M:test` runs from."
  (:require [clojure.test :refer [deftest is testing]]
            [clojure.java.io :as io]
            [cheshire.core :as json]
            [polismath.math.named-matrix :as nm]))

(def ^:private driver-loaded?
  (let [f (io/file "dev/replay.clj")]
    (when (.exists f)
      (load-file (.getPath f))
      true)))

(defn- v [sym] @(ns-resolve 'replay sym))

(deftest driver-loads
  (is driver-loaded?
      "dev/replay.clj must be loadable from math/ (run tests with cwd=math)"))

;; ---------------------------------------------------------------------------
;; Key order.
;; ---------------------------------------------------------------------------

(deftest key-order-is-sorted-as-strings
  (when driver-loaded?
    (let [->plain (v '->plain)
          write   (v 'stage-json-string)]
      (testing "keyword keys are emitted in sorted order regardless of literal order"
        (is (= "{\"a\":1,\"b\":2,\"c\":3}"
               (write (->plain {:c 3 :a 1 :b 2})))))
      (testing "integer keys are stringified FIRST, then sorted as strings —
                so \"10\" precedes \"2\", which is what Python's sort_keys does
                after the same stringification"
        (is (= "{\"1\":1,\"10\":10,\"2\":2}"
               (write (->plain {2 2, 10 10, 1 1})))))
      (testing "nested objects are sorted at every level"
        (is (= "{\"outer\":{\"x\":{\"a\":1,\"z\":2}}}"
               (write (->plain {:outer {:x {:z 2 :a 1}}}))))))))

(deftest stage-names-sort-into-pipeline-order
  (when driver-loaded?
    (let [order (v 'stage-order)]
      (is (= order (vec (sort order)))
          "zero-padded stage names must make lexicographic order == pipeline order")
      (is (= (count order) (count (distinct order)))))))

;; ---------------------------------------------------------------------------
;; Numbers: integers stay integers, doubles round-trip exactly.
;; ---------------------------------------------------------------------------

(deftest integers-emit-without-a-decimal-point
  (when driver-loaded?
    (let [->plain (v '->plain) write (v 'stage-json-string)]
      (is (= "[0,1,-7,2147483648,9007199254740993]"
             (write (->plain [0 1 -7 2147483648 9007199254740993]))))
      (is (= "{\"id\":42}" (write (->plain {:id (int 42)})))))))

(def ^:private tricky-doubles
  [0.0 -0.0 1.0 -1.0 0.1 (+ 0.1 0.2) (/ 1.0 3.0)
   1.0E-5 1.0E10 1.0E300 1.0E-300
   Double/MIN_VALUE Double/MAX_VALUE
   (Math/nextUp 1.0) (Math/nextDown 1.0)
   4.9E-324 2.2250738585072014E-308
   0.888888888888889 2.8284271247461903 1.635555555555556])

(deftest doubles-round-trip-bit-for-bit
  (when driver-loaded?
    (let [write (v 'stage-json-string) ->plain (v '->plain)]
      (testing "every emitted double parses back to the SAME double — the
                emitter uses the shortest round-tripping repr and never rounds"
        (doseq [d tricky-doubles]
          (let [text (write (->plain d))
                back (Double/parseDouble text)]
            (is (= (Double/doubleToRawLongBits (double d))
                   (Double/doubleToRawLongBits back))
                (str "round-trip failed for " d " (emitted " text ")")))))
      (testing "a large random sample of doubles also round-trips"
        (let [rng (java.util.Random. 20260908)]
          (dotimes [_ 5000]
            (let [d (Double/longBitsToDouble (.nextLong rng))]
              (when (and (not (Double/isNaN d)) (not (Double/isInfinite d)))
                (is (= (Double/doubleToRawLongBits d)
                       (Double/doubleToRawLongBits
                         (Double/parseDouble (write (->plain d))))))))))))))

(deftest non-finite-doubles-become-json-strings
  (when driver-loaded?
    (let [write (v 'stage-json-string) ->plain (v '->plain)]
      (is (= "[\"NaN\",\"Infinity\",\"-Infinity\"]"
             (write (->plain [Double/NaN
                              Double/POSITIVE_INFINITY
                              Double/NEGATIVE_INFINITY]))))
      (testing "and the result is still parseable JSON (JSON has no NaN literal)"
        (is (= ["NaN" "Infinity" "-Infinity"]
               (json/parse-string
                 (write (->plain [Double/NaN
                                  Double/POSITIVE_INFINITY
                                  Double/NEGATIVE_INFINITY])))))))))

;; ---------------------------------------------------------------------------
;; Shapes.
;; ---------------------------------------------------------------------------

(deftest named-matrix-emits-rownames-colnames-matrix
  (when driver-loaded?
    (let [->plain (v '->plain) write (v 'stage-json-string)
          m (nm/update-nmat (nm/named-matrix)
                            [[1 10 -1] [1 11 1] [2 10 0]])
          parsed (json/parse-string (write (->plain m)))]
      (is (= #{"rownames" "colnames" "matrix"} (set (keys parsed))))
      (is (= [1 2] (get parsed "rownames")))
      (is (= [10 11] (get parsed "colnames")))
      (testing "an unvoted cell is null, not 0 — nil vs 0 is meaning, not shape"
        (is (= [[-1 1] [0 nil]] (get parsed "matrix")))))))

(deftest sets-become-sorted-arrays-and-keywords-become-names
  (when driver-loaded?
    (let [->plain (v '->plain) write (v 'stage-json-string)]
      (is (= "[1,2,3,10]" (write (->plain #{10 1 3 2}))))
      (is (= "\"agree\"" (write (->plain :agree))))
      (is (= "{\"repful-for\":\"disagree\"}"
             (write (->plain {:repful-for :disagree})))))))

(deftest unsupported-values-throw-rather-than-being-printed
  (when driver-loaded?
    (let [->plain (v '->plain)]
      (is (thrown? clojure.lang.ExceptionInfo (->plain (Object.)))))))

(deftest json-escapes-control-characters
  (when driver-loaded?
    (let [->plain (v '->plain) write (v 'stage-json-string)
          s "a\"b\\c\nd\te"]
      (is (= s (json/parse-string (write (->plain s))))))))

;; ---------------------------------------------------------------------------
;; Input digest.
;; ---------------------------------------------------------------------------

(deftest input-digest-is-in-export-sign-convention
  (when driver-loaded?
    (let [digest (v 'step-input-digest)
          step {:index 0
                :votes [{:pid 1 :tid 2 :sign 1 :t-ms 1000}
                        {:pid 1 :tid 3 :sign -1 :t-ms 2000}]
                :mods []}]
      (testing "stable and prefixed"
        (is (= (digest step) (digest step)))
        (is (.startsWith ^String (digest step) "sha256:")))
      (testing "the digest is over the CSV/export sign, so it is not disturbed by
                the raw-DB flip conv-update consumes — it is what makes the clj
                and py manifests comparable"
        (is (not= (digest step)
                  (digest (update step :votes
                                  (fn [vs] (mapv #(update % :sign -) vs)))))))
      (testing "moderation rows participate"
        (is (not= (digest step)
                  (digest (assoc step :mods
                                 [{:tid 2 :is_meta true :mod -1 :modified 5}]))))))))

;; ---------------------------------------------------------------------------
;; Document shape.
;; ---------------------------------------------------------------------------

(deftest stage-document-carries-every-stage-and-the-manifest-fields
  (when driver-loaded?
    (let [doc-fn (v 'stage-document)
          write  (v 'stage-json-string)
          order  (v 'stage-order)
          conv   {:last-vote-timestamp 1234 :n 0 :n-cmts 0}
          step   {:index 3 :votes [] :mods []}
          text   (write (doc-fn step conv))
          parsed (json/parse-string text)]
      (is (= #{"comment_projection_axes" "engine" "input_digest" "schema"
               "stages" "step" "tick" "vote_sign_convention"}
             (set (keys parsed))))
      (testing "the comment-projection axis orientation is DECLARED, so a
                comparer never has to guess it from array lengths (review F4)"
        (is (= "comps-by-tids" (get parsed "comment_projection_axes"))))
      (is (= "polis-stage-dump/1" (get parsed "schema")))
      (is (= "clj" (get parsed "engine")))
      (is (= "raw-db" (get parsed "vote_sign_convention")))
      (is (= 3 (get parsed "step")))
      (is (= 1234 (get parsed "tick")))
      (testing "stages appear in the emitted TEXT in pipeline order (a parsed
                map is unordered, so the byte order is what must be asserted)"
        (is (= (vec order)
               (vec (sort-by #(.indexOf ^String text (str "\"" % "\"")) order)))))
      (testing "a node the conv does not carry is null, never dropped"
        (is (contains? (get-in parsed ["stages" "R04_pca"]) "pca"))
        (is (nil? (get-in parsed ["stages" "R04_pca" "pca"])))))))
