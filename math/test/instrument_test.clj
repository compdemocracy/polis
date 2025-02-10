(ns instrument-test
  (:require [clojure.test :refer :all]
            [polismath.util.instrument :as instrument]
            [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.core.matrix :as matrix]
            [clojure.core.matrix.stats :as matrix-stats]
            [taoensso.timbre :as log]))

;; Test namespace and functions that we'll instrument
(ns-unmap *ns* 'test-fn)
(defn test-fn [x y] (+ x y))
(defn another-test-fn [x] (* x 2))

(def test-dir "/tmp/test-instrument")

(defn get-json-files []
  (let [dir (io/file test-dir)]
    (when (.exists dir)
      (->> (file-seq dir)
           (filter #(.isFile %))
           (filter #(.endsWith (.getName %) ".json"))
           (sort-by #(.lastModified %))))))

(defn read-json-file [file]
  (when (and file (.exists file))
    (json/parse-string (slurp file) false)))

(defn get-records []
  (when-let [files (get-json-files)]
    (->> files
         (map read-json-file)
         vec)))

(defn clear-test-dir! []
  (when-let [dir (io/file test-dir)]
    (when (.exists dir)
      (doseq [f (reverse (file-seq dir))]
        (io/delete-file f true)))))

(use-fixtures :each
  (fn [f]
    (clear-test-dir!)
    (instrument/clear-instrumentation!)
    (instrument/configure-instrumentation! {:enabled true
                                         :output-dir test-dir})
    (f)
    (clear-test-dir!)))

(defn get-first-record [records]
  (first records))

(defn get-second-record [records]
  (second records))

(deftest test-single-function-instrumentation
  (testing "Instrumenting a single function records its calls correctly"
    (instrument/clear-instrumentation!)  ; Start with clean state
    (instrument/configure-instrumentation! {:enabled true
                                         :output-dir test-dir})
    (instrument/instrument-fn #'test-fn)
    (test-fn 2 3)
    (test-fn 2 3)  ; Call it multiple times to verify all calls are recorded
    (test-fn 2 3)
    (test-fn 2 3)
    (let [records (get-records)
          first-record (get-first-record records)]
      (is (= 4 (count records)) "Should record every call")
      (is (= "polismath.util.instrument-test/test-fn" (get first-record "fn-name"))
          "Should record correct function name")
      (is (= ["2" "3"] (get first-record "args")) "Should record arguments as list")
      (is (= {} (get first-record "kwargs")) "Should have empty kwargs map")
      (is (= "5" (get first-record "result")) "Should record result")
      (is (number? (get first-record "timestamp")) "Should have a timestamp")
      (is (number? (get first-record "duration-ms")) "Should record duration"))))

(deftest test-namespace-instrumentation
  (testing "Instrumenting namespace with predicate"
    (instrument/clear-instrumentation!)  ; Start with clean state
    (instrument/configure-instrumentation! {:enabled true
                                         :output-dir test-dir})
    (instrument/instrument-ns 'instrument-test
                            #(= (str %) "test-fn"))
    (test-fn 2 3)
    (test-fn 2 3)
    (test-fn 2 3)
    (another-test-fn 4)  ; This call should not be recorded due to predicate
    (let [records (get-records)]
      (is (= 3 (count records))
          "Should record all calls to functions matching predicate"))))

(deftest test-file-writing
  (testing "Direct file writing behavior"
    (instrument/configure-instrumentation!
     {:output-dir test-dir})
    (instrument/instrument-fn #'test-fn)
    (test-fn 1 1)
    (test-fn 2 2)
    (test-fn 3 3)
    (let [records (get-records)]
      (is (= 3 (count records))
          "Should have written all three calls to disk"))))

(deftest test-instrumentation-disabled
  (testing "No recording when disabled"
    (clear-test-dir!)
    (instrument/configure-instrumentation! {:enabled false
                                         :output-dir test-dir})
    (instrument/instrument-fn #'test-fn)
    (test-fn 1 2)
    (let [dir (io/file test-dir)]
      (is (or (not (.exists dir))
              (empty? (filter #(.isFile %) (file-seq dir))))
          "Should not create any files when disabled"))))

(deftest test-error-handling
  (testing "Instrumentation preserves original function errors"
    (ns-unmap *ns* 'error-fn)
    (defn error-fn [] (throw (Exception. "test error")))
    (instrument/instrument-fn #'error-fn)
    (is (thrown-with-msg? Exception #"test error" (error-fn))
        "Should preserve original exception")))

(deftest test-multiple-arity-functions
  (testing "Handles multiple arity functions"
    (ns-unmap *ns* 'multi-arity-fn)
    (defn multi-arity-fn
      ([x] x)
      ([x y] (+ x y)))
    (instrument/instrument-fn #'multi-arity-fn)
    (is (= 1 (multi-arity-fn 1)) "Single arity should work")
    (is (= 3 (multi-arity-fn 1 2)) "Multiple arity should work")
    (let [records (get-records)
          first-record (get-first-record records)
          second-record (get-second-record records)]
      (is (= 2 (count records)) "Should record both arity calls")
      (is (= ["1"] (get first-record "args")) "Should record single arity args")
      (is (= {} (get first-record "kwargs")) "Should have empty kwargs map for single arity")
      (is (= ["1" "2"] (get second-record "args")) "Should record multiple arity args")
      (is (= {} (get second-record "kwargs")) "Should have empty kwargs map for multiple arity"))))

(deftest test-keyword-arguments
  (testing "Handles functions with keyword arguments"
    (ns-unmap *ns* 'kwarg-fn)
    (defn kwarg-fn
      [data n-comps & {:keys [iters start-vectors]}]
      {:data data
       :n-comps n-comps
       :iters (or iters 100)
       :start-vectors start-vectors})
    
    (instrument/instrument-fn #'kwarg-fn)
    
    ;; Test with no kwargs
    (let [result1 (kwarg-fn [[1 2 3]] 2)]
      (is (= {:data [[1 2 3]] :n-comps 2 :iters 100 :start-vectors nil} result1)
          "Should work with no keyword args"))
    
    ;; Test with some kwargs
    (let [result2 (kwarg-fn [[1 2 3]] 2 :start-vectors [[1 1 1]] :iters 50)]
      (is (= {:data [[1 2 3]] :n-comps 2 :iters 50 :start-vectors [[1 1 1]]} result2)
          "Should work with keyword args"))
    
    (let [records (get-records)
          first-record (get-first-record records)
          second-record (get-second-record records)]
      (is (= 2 (count records)) "Should record both calls")
      
      ;; Check first call (no kwargs)
      (is (= ["[[1 2 3]]" "2"] (get first-record "args"))
          "Should record positional args correctly")
      (is (= {} (get first-record "kwargs"))
          "Should have empty kwargs map when no keyword args used")
      
      ;; Check second call (with kwargs)
      (is (= ["[[1 2 3]]" "2"] (get second-record "args"))
          "Should record positional args correctly")
      (is (= {"iters" "50" "start-vectors" "[[1 1 1]]"} (get second-record "kwargs"))
          "Should record keyword args correctly")
      
      ;; Check result format
      (is (= {"data" "[[1 2 3]]"
              "iters" "100"
              "n-comps" "2"
              "start-vectors" "nil"} (get first-record "result"))
          "Should record map result with string keys"))))

(deftest test-matrix-arguments
  (testing "Handles matrix arguments correctly"
    (matrix/set-current-implementation :vectorz)
    (ns-unmap *ns* 'matrix-fn)
    (defn matrix-fn
      [data & {:keys [center]}]
      (if center
        (let [mean (matrix-stats/mean data)]
          (matrix/sub data mean))
        data))
    
    (instrument/instrument-fn #'matrix-fn)
    
    ;; Create test matrices
    (let [test-matrix (matrix/matrix [[1 2 3]
                                     [4 5 6]
                                     [7 8 9]])
          ;; Call with and without keyword args
          result1 (matrix-fn test-matrix)
          result2 (matrix-fn test-matrix :center true)]
      
      ;; Verify function works correctly
      (is (matrix/equals test-matrix result1)
          "Should return original matrix when not centered")
      (is (matrix/equals (matrix/matrix [[-3 -3 -3]
                                       [0  0  0]
                                       [3  3  3]])
                        result2)
          "Should return centered matrix when center=true")
      
      ;; Check instrumentation records
      (let [records (get-records)
            first-record (get-first-record records)
            second-record (get-second-record records)]
        (is (= 2 (count records)) "Should record both calls")
        
        ;; First call (no keyword args)
        (is (= ["#matrix [[1.0 2.0 3.0] [4.0 5.0 6.0] [7.0 8.0 9.0]]"]
               (get first-record "args"))
            "Should record matrix arguments correctly")
        (is (= {} (get first-record "kwargs"))
            "Should have empty kwargs map when no keyword args used")
        
        ;; Second call (with keyword args)
        (is (= ["#matrix [[1.0 2.0 3.0] [4.0 5.0 6.0] [7.0 8.0 9.0]]"]
               (get second-record "args"))
            "Should record matrix argument correctly")
        (is (= {"center" "true"}
               (get second-record "kwargs"))
            "Should record keyword arguments correctly")
        
        ;; Check results are recorded correctly
        (is (= "#matrix [[1.0 2.0 3.0] [4.0 5.0 6.0] [7.0 8.0 9.0]]"
               (get first-record "result"))
            "Should record matrix result correctly")
        (is (= "#matrix [[-3.0 -3.0 -3.0] [0.0 0.0 0.0] [3.0 3.0 3.0]]"
               (get second-record "result"))
            "Should record centered matrix result correctly")))))