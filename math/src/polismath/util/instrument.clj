;; Instrumentation library for recording function calls and their results.
;; 
;; JSON Format Documentation:
;; Each function call is recorded in a separate JSON file with the following structure:
;; {
;;   "fn-name": "fully.qualified/function-name",
;;   "args": [list of positional arguments],
;;   "kwargs": {dictionary of keyword arguments},
;;   "result": value,
;;   "timestamp": unix-timestamp-in-ms,
;;   "duration-ms": execution-time-in-ms
;; }
;;
;; Examples of different call patterns and type serialization:
;;
;; 1. Simple Function Call with Basic Types:
;;    Clojure: (test-fn "hello" 42 true nil)
;;    {
;;      "fn-name": "polismath.util.instrument-test/test-fn",
;;      "args": ["hello", 42, true, null],
;;      "kwargs": {},
;;      "result": "hello"
;;    }
;;
;; 2. Mixed Positional and Keyword Arguments:
;;    Clojure: (kwarg-fn [[1 2 3]] 2 :start-vectors [[1 1 1]] :iters 50)
;;    {
;;      "fn-name": "polismath.util.instrument-test/kwarg-fn",
;;      "args": [[[1 2 3]], 2],
;;      "kwargs": {
;;        "start-vectors": [[1 1 1]],
;;        "iters": 50
;;      },
;;      "result": {
;;        "data": [[1 2 3]],
;;        "n-comps": 2,
;;        "iters": 50,
;;        "start-vectors": [[1 1 1]]
;;      }
;;    }
;;
;; 3. Matrix Arguments and Results:
;;    Clojure: (matrix-fn (matrix [[1 2] [3 4]]) :center true)
;;    {
;;      "fn-name": "polismath.util.instrument-test/matrix-fn",
;;      "args": ["#matrix [[1.0 2.0] [3.0 4.0]]"],
;;      "kwargs": {
;;        "center": true
;;      },
;;      "result": "#matrix [[-1.5 -1.5] [1.5 1.5]]"
;;    }
;;
;; 4. Nested Data Structures with Mixed Types:
;;    Clojure: (nested-type-fn [[1 "a"] {:b 2 :c ["b" 3]} [4 "d"]])
;;    {
;;      "fn-name": "polismath.util.instrument-test/nested-type-fn",
;;      "args": [[[1, "a"], {"b": 2, "c": ["b", 3]}, [4, "d"]]],
;;      "kwargs": {},
;;      "result": {
;;        "original": [[1, "a"], {"b": 2, "c": ["b", 3]}, [4, "d"]],
;;        "processed": [[1, "a"], {"b": 2, "c": ["b", 3]}, [4, "d"]]
;;      }
;;    }
;;
;; Type Serialization Rules:
;; - Numbers: Preserved as raw numbers (e.g., 42, 3.14)
;; - Strings: Preserved as strings (e.g., "hello")
;; - Booleans: Preserved as true/false
;; - nil: Serialized as null
;; - Keywords: Converted to strings with : prefix (e.g., ":keyword")
;; - Vectors/Lists: Preserved as arrays with elements serialized according to their types
;; - Maps: Converted to objects with string keys (keyword keys have : stripped)
;; - Matrices: Serialized as strings with "#matrix" prefix and nested vector representation
;;
;; File Naming Convention:
;; {timestamp}_{function-name}_in_{num-inputs}_out_{num-outputs}.json
;; Example: 2024-02-10-14-28-38-993_test-fn_in_2_out_1.json

(ns polismath.util.instrument
  (:require [clojure.java.io :as io]
            [cheshire.core :as json]
            [clojure.string :as str]
            [taoensso.timbre :as log]
            [clojure.core.matrix :as matrix])
  (:import [java.time LocalDateTime]
           [java.time.format DateTimeFormatter]))

(def default-config
  {:enabled true
   :output-dir "instrumentation"})

(def instrumentation-config (atom default-config))

(def instrumented-fns (atom #{}))
(def ^:private original-fns (atom {}))

(defn configure-instrumentation! [config]
  (log/debug "Configuring instrumentation with:" config)
  (let [merged-config (merge default-config config)]
    (reset! instrumentation-config merged-config)
    (when-let [dir (:output-dir merged-config)]
      (io/make-parents (str dir "/dummy")))))

(defn- format-value [v]
  v)
  ;; (cond
  ;;   (nil? v) nil                     ; Keep nil as nil
  ;;   (number? v) v                    ; Keep numbers as is
  ;;   (boolean? v) v                   ; Keep booleans as is
  ;;   (string? v) v                    ; Keep strings as is
  ;;   (keyword? v) (str ":" (name v))  ; Convert keywords to strings with : prefix
  ;;   (instance? mikera.vectorz.Vector v) ; Handle vectors
  ;;     v ; (str "#matrix " (pr-str (matrix/to-nested-vectors v)))
  ;;   (instance? mikera.matrixx.Matrix v) ; Handle matrices
  ;;     (str "#matrix " (pr-str (matrix/to-nested-vectors v)))
  ;;   (or (sequential? v) (set? v))    ; Handle collections
  ;;     (mapv format-value v)
  ;;   (map? v)                         ; Handle maps
  ;;     (into (sorted-map)
  ;;           (map (fn [[k v]]
  ;;                 [(if (keyword? k) (name k) (str k))
  ;;                   (format-value v)])
  ;;               v))
  ;;   :else (str v)))                  ; Convert everything else to string

(defn- format-args [args-seq]
  (let [args (vec args-seq)
        ; Split args into positional and keyword args
        [positional-args kw-args] (split-with (complement keyword?) args)
        ; Format positional args as a vector
        args-list (mapv format-value positional-args)
        ; Format keyword args as a map (if any)
        kwargs (when (seq kw-args)
                (into (sorted-map)
                      (map (fn [[k v]]
                            [(name k) (format-value v)])
                           (partition 2 kw-args))))]
    {:args args-list
     :kwargs (or kwargs {})}))

(defn- format-result [result]
  (cond
    (map? result)
    (into (sorted-map)
          (map (fn [[k v]]
                 [(if (keyword? k) (name k) (str k))
                  (format-value v)])
               result))
    
    (or (sequential? result) (set? result))
    (mapv format-value result)
    
    :else
    (format-value result)))

(defn- count-outputs [result]
  (cond
    (or (sequential? result) (set? result)) (count result)
    (map? result) (count result)
    :else 1))

(defn- format-filename [fn-name args result timestamp]
  (let [datetime (LocalDateTime/now)
        formatter (DateTimeFormatter/ofPattern "yyyy-MM-dd-HH-mm-ss")
        formatted-time (str (.format datetime formatter) "-" (mod timestamp 1000))
        clean-fn-name (-> fn-name
                         str
                         (str/replace #"^#'" "")
                         (str/replace #"^instrument-test/" "")
                         (str/replace #"/" "_")
                         (str/replace #"\." "_"))
        num-inputs (count args)
        num-outputs (count-outputs result)]
    (format "%s_%s_in_%d_out_%d.json"
            formatted-time
            clean-fn-name
            num-inputs
            num-outputs)))

(defn- record-call! [fn-name args result duration-ms]
  (log/debug "Recording call for" fn-name "with" (count args) "args")
  (when (:enabled @instrumentation-config)
    (let [timestamp (System/currentTimeMillis)
          fn-name-str (-> fn-name
                         str
                         (str/replace #"^#'" "")
                         (str/replace #"^instrument-test/" "polismath.util.instrument-test/"))
          formatted-args (format-args args)
          record {:fn-name fn-name-str
                 :args (:args formatted-args)
                 :kwargs (:kwargs formatted-args)
                 :result (format-result result)
                 :timestamp timestamp
                 :duration-ms duration-ms}]
      (log/debug "Created a record")
      (when-let [output-dir (:output-dir @instrumentation-config)]
        (let [filename (str output-dir "/" (format-filename fn-name args result timestamp))]
          (log/debug "Writing to file:" filename)
          (io/make-parents filename)
          (spit filename (json/generate-string record {:pretty true})))))))

(defn instrument-fn
  "Instruments a function with the given options."
  [fn-var & [opts]]
  (log/debug "Instrumenting function" fn-var "with opts:" opts)
  (when-not (@instrumented-fns fn-var)
    (swap! instrumented-fns conj fn-var)
    (let [orig-fn @fn-var]
      (swap! original-fns assoc fn-var orig-fn)
      (alter-var-root
       fn-var
       (fn [f]
         (fn [& args]
           (log/debug "Calling instrumented function" fn-var "with" (count args) "args")
           (let [start-time (System/nanoTime)
                 result (try
                         (apply orig-fn args)
                         (catch Throwable t
                           (log/error "Error in instrumented function" fn-var)
                           (throw t)))
                 end-time (System/nanoTime)
                 duration-ms (/ (- end-time start-time) 1000000.0)]
             (when (:enabled @instrumentation-config)
               (record-call! fn-var args result duration-ms))
             result)))))))

(defn clear-instrumentation!
  "Clears all instrumentation state."
  []
  (log/debug "Clearing instrumentation")
  (doseq [[fn-var orig-fn] @original-fns]
    (alter-var-root fn-var (constantly orig-fn)))
  (reset! instrumented-fns #{})
  (reset! original-fns {}))

(defn instrument-ns
  "Instruments all functions in the given namespace that match the predicate."
  [ns-sym pred]
  (log/debug "Instrumenting namespace" ns-sym "with predicate:" pred)
  (clear-instrumentation!)
  (doseq [[sym var] (ns-interns (find-ns ns-sym))
          :when (and (fn? @var)
                     (pred sym))]
    (instrument-fn var))) 