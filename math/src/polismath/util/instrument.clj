(ns polismath.util.instrument
  (:require [clojure.java.io :as io]
            [cheshire.core :as json]
            [clojure.string :as str]
            [taoensso.timbre :as log]
            [clojure.core.matrix :as matrix]))

(def default-config
  {:enabled true
   :output-dir "instrumentation"
   :max-buffer-size 1000})

(def instrumentation-config (atom default-config))

(def instrumented-calls (atom []))
(def instrumented-fns (atom #{}))
(def ^:private original-fns (atom {}))

(defn configure-instrumentation! [config]
  (log/debug "Configuring instrumentation with:" config)
  (let [merged-config (merge default-config config)]
    (reset! instrumentation-config merged-config)
    (when-let [dir (:output-dir merged-config)]
      (io/make-parents (str dir "/dummy")))))

(defn- write-buffer-to-disk! []
  (log/debug "Writing buffer to disk")
  (when-let [output-dir (:output-dir @instrumentation-config)]
    (let [filename (str output-dir "/" (System/currentTimeMillis) ".json")]
      (log/debug "Writing to file:" filename)
      (io/make-parents filename)
      (spit filename (json/generate-string @instrumented-calls))
      (reset! instrumented-calls []))))

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

(defn- record-call! [fn-name args result duration-ms]
  (log/debug "Recording call for" fn-name "with" (count args) "args")
  (when (:enabled @instrumentation-config)
    (let [fn-name-str (-> fn-name
                         str
                         (str/replace #"^#'" "")
                         (str/replace #"^instrument-test/" "polismath.util.instrument-test/"))
          record {:fn-name fn-name-str
                 :args (format-args args)
                 :result (format-value result)
                 :timestamp (System/currentTimeMillis)
                 :duration-ms duration-ms}]
      (log/debug "Created a record")
      (swap! instrumented-calls conj record)
      (when (and (:enabled @instrumentation-config)
                 (>= (count @instrumented-calls) (:max-buffer-size @instrumentation-config)))
        (log/debug "Buffer full, flushing to disk")
        (write-buffer-to-disk!)))))

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
  (reset! instrumented-calls [])
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

(defn flush-instrumentation!
  "Flushes the instrumentation buffer to disk."
  []
  (log/debug "Flushing instrumentation buffer")
  (when (and (:enabled @instrumentation-config)
             (not-empty @instrumented-calls))
    (write-buffer-to-disk!))) 