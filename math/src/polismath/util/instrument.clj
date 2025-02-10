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

(defn- format-matrix [m]
  (str "#matrix " (pr-str (matrix/to-nested-vectors m))))

(defn- format-value [v]
  (cond
    (instance? mikera.matrixx.Matrix v) (format-matrix v)
    :else (pr-str v)))

(defn- format-args [args]
  (let [formatted-args (map (fn [arg]
                             (if (instance? mikera.matrixx.Matrix arg)
                               (format-matrix arg)
                               (pr-str arg)))
                           args)]
    (str "(" (str/join " " formatted-args) ")")))

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
          record {:fn-name fn-name-str
                 :args (format-args args)
                 :result (format-value result)
                 :timestamp timestamp
                 :duration-ms duration-ms}]
      (log/debug "Created a record")
      (when-let [output-dir (:output-dir @instrumentation-config)]
        (let [filename (str output-dir "/" (format-filename fn-name args result timestamp))]
          (log/debug "Writing to file:" filename)
          (io/make-parents filename)
          (spit filename (json/generate-string [record] {:pretty true})))))))

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