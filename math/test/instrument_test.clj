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
      (is (= [2 3] (get first-record "args")) "Should record arguments as list")
      (is (= {} (get first-record "kwargs")) "Should have empty kwargs map")
      (is (= 5 (get first-record "result")) "Should record result")
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
      (is (= [1] (get first-record "args")) "Should record single arity args")
      (is (= {} (get first-record "kwargs")) "Should have empty kwargs map for single arity")
      (is (= [1 2] (get second-record "args")) "Should record multiple arity args")
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
      (is (= [[[1 2 3]] 2] (get first-record "args"))
          "Should record positional args correctly")
      (is (= {} (get first-record "kwargs"))
          "Should have empty kwargs map when no keyword args used")
      
      ;; Check second call (with kwargs)
      (is (= [[[1 2 3]] 2] (get second-record "args"))
          "Should record positional args correctly")
      (is (= {"iters" 50 "start-vectors" [[1 1 1]]} (get second-record "kwargs"))
          "Should record keyword args correctly")
      
      ;; Check result format
      (is (= {"data" [[1 2 3]]
              "iters" 100
              "n-comps" 2
              "start-vectors" nil} (get first-record "result"))
          "Should record map result with string keys"))))

(deftest test-data-serialization
  (testing "Serialization of different data types and structures"
    (clear-test-dir!)  ; Start with clean state
    (instrument/clear-instrumentation!)
    (instrument/configure-instrumentation! {:enabled true
                                         :output-dir test-dir})
    
    ;; Test basic types
    (ns-unmap *ns* 'type-test-fn)
    (defn type-test-fn
      [string-arg number-arg bool-arg nil-arg & {:keys [keyword-arg vector-arg map-arg]}]
      {:string string-arg
       :number number-arg
       :bool bool-arg
       :nil nil-arg
       :keyword keyword-arg
       :vector vector-arg
       :map map-arg})
    
    (instrument/instrument-fn #'type-test-fn)
    
    ;; Call with different types
    (type-test-fn 
      "hello"           ; string
      42               ; number
      true             ; boolean
      nil              ; nil
      :keyword-arg :test-key        ; keyword
      :vector-arg [1 2.5 "three"]  ; vector with mixed types
      :map-arg {:a 1 :b true}   ; map with mixed types
    )
    
    (let [records (get-records)
          record (get-first-record records)]
      
      (testing "Basic type serialization"
        ;; Check argument serialization
        (is (= ["hello" 42 true nil] 
               (get record "args"))
            "Should serialize positional arguments with correct types")
        
        ;; Check keyword argument serialization
        (is (= {"keyword-arg" "test-key"
                "vector-arg" [1 2.5 "three"]
                "map-arg" {"a" 1 "b" true}}
               (get record "kwargs"))
            "Should serialize keyword arguments with correct types")
        
        ;; Check result serialization
        (is (= {"string" "hello"
                "number" 42
                "bool" true
                "nil" nil
                "keyword" "test-key"
                "vector" [1 2.5 "three"]
                "map" {"a" 1 "b" true}}
               (get record "result"))
            "Should serialize result map with correct types")))

    ;; Test matrix serialization
    (testing "Matrix serialization"
      (matrix/set-current-implementation :vectorz)
      (ns-unmap *ns* 'matrix-fn)
      (defn matrix-fn [m]
        {:input m
         :scaled (mapv #(mapv (partial * 2) %) m)})
      
      (instrument/instrument-fn #'matrix-fn)
      
      ;; Test regular matrix
      (let [test-matrix [[1.0 2.0] [3.0 4.0]]
            _ (matrix-fn test-matrix)
            records (get-records)
            record (last records)]
        
        (is (= [[[1.0 2.0] [3.0 4.0]]]
               (get record "args"))
            "Should serialize matrix as nested vectors")
        
        (is (= {"input" [[1.0 2.0] [3.0 4.0]]
                "scaled" [[2.0 4.0] [6.0 8.0]]}
               (get record "result"))
            "Should serialize matrix results as nested vectors"))

      ;; Test matrix with NaN
      (let [test-matrix [[1.0 Double/NaN] [3.0 4.0]]
            _ (matrix-fn test-matrix)
            records (get-records)
            record (last records)]
        
        (is (= [[[1.0 "NaN"] [3.0 4.0]]]
               (get record "args"))
            "Should serialize matrix with NaN as nested vectors")
        
        (is (= {"input" [[1.0 "NaN"] [3.0 4.0]]
                "scaled" [[2.0 "NaN"] [6.0 8.0]]}
               (get record "result"))
            "Should serialize matrix with NaN as nested vectors")))

    ;; Test nested data structures
    (testing "Nested data structures"
      (ns-unmap *ns* 'nested-type-fn)
      (defn nested-type-fn [data]
        {:original data
         :processed data})
      
      (instrument/instrument-fn #'nested-type-fn)
      
      (let [nested-data [[1 "a"] {:b 2 :c ["b" 3]} [4 "d"]]
            _ (nested-type-fn nested-data)
            records (get-records)
            record (last records)]
        
        (is (= [[[1 "a"] {"b" 2 "c" ["b" 3]} [4 "d"]]]
               (get record "args"))
            "Should serialize nested data structures correctly")
        
        (is (= {"original" [[1 "a"] {"b" 2 "c" ["b" 3]} [4 "d"]]
                "processed" [[1 "a"] {"b" 2 "c" ["b" 3]} [4 "d"]]}
               (get record "result"))
            "Should serialize nested result structures correctly")))))