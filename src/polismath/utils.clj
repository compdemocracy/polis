(ns polismath.utils
  (:use alex-and-georges.debug-repl
        clojure.core.matrix)
  (:require [taoensso.timbre.profiling :as profiling
             :refer (pspy pspy* profile defnp p p*)]
            [clojure.tools.reader.edn :as edn]
            [clojure.core.matrix :as mat]
            [clojure.tools.trace :as tr]))

(set-current-implementation :vectorz)


(defn agree? [n]
  (and 
    (not (nil? n))
    (< n 0)))


(defn disagree? [n]
  (and
    (not (nil? n))
    (> n 0)))


(defmacro time2
  [tag & expr]
  `(let [start# (. System (nanoTime))
         ret# ~@expr]
     (println (str (System/currentTimeMillis) " " ~tag " " (/ (double (- (. System (nanoTime)) start#)) 1000000.0) " msecs"))
     ret#))


(defn zip [& xss]
  ;;should we redo this like the with-indices below, using a map?
  (if (> (count xss) 1)
    (partition (count xss) (apply interleave xss))
    xss))


(let [greedy? true]
  (defn greedy [iter]
    (if greedy?
      (into [] iter)
      iter)))


(defn greedy-false [iter] iter)


(defn ^long typed-indexof [^java.util.List coll item]
  (.indexOf coll item))


(defmacro endlessly [interval & forms]
  `(doseq [~'x (range)]
     ~@forms
     (Thread/sleep ~interval)))


(defn with-indices [coll]
  (map #(vector %1 %2) (range) coll))


(defn filter-by-index [coll idxs] 
  (greedy-false
  (let [idx-set (set idxs)]
    (->> (with-indices coll)
      (filter #(idx-set (first %)))
      (map second)))
    ))


(defn apply-kwargs
  "Takes a function f, any number of regular args, and a final kw-args argument which will be
  splatted in as a final argument"
  [f & args]
  (apply (apply partial f (butlast args)) (apply concat (last args))))


(defn use-debuggers
  "Handy debugging utility for loading in debugging namespaces - doesn't really always work. XXX - maybe
  use Vinyasa?"
  []
  (require '[alex-and-georges.debug-repl :as dr])
  (require '[clojure.tools.trace :as tr]))


(defn prep-for-uploading-bidToPid-mapping [results]
  {"bidToPid" (:bid-to-pid results)})


;; Creating some overrides for how core.matrix instances are printed, so that we can read them back via our
;; edn reader

(def ^:private ipv-print-method (get (methods print-method) clojure.lang.IPersistentVector))

(defmethod print-method mikera.matrixx.Matrix
  [o ^java.io.Writer w]
  (.write w "#mikera.matrixx.Matrix ")
  (ipv-print-method
    (mapv #(into [] %) o)
    w))

(defmethod print-method mikera.vectorz.Vector
  [o ^java.io.Writer w]
  (.write w "#mikera.vectorz.Vector ")
  (ipv-print-method o w))

(defmethod print-method mikera.arrayz.NDArray
  [o ^java.io.Writer w]
  (.write w "#mikera.arrayz.NDArray ")
  (ipv-print-method o w))

; a reader that uses these custom printing formats
(defn read-vectorz-edn [text]
  (edn/read-string
    {:readers {'mikera.vectorz.Vector mat/matrix
               'mikera.arrayz.NDArray mat/matrix
               'mikera.matrixx.Matrix mat/matrix}}
    text))


(defn conv-update-dump [conv votes & [opts error]]
  (spit (str "errorconv." (. System (nanoTime)) ".edn")
    ; XXX - not sure if the print-method calls will work just in this namespace or not...
    (prn-str
      {:conv  (into {}
                (assoc-in conv [:pca :center] (matrix (into [] (:center (:pca conv))))))
       :votes votes
       :opts  opts
       :error (str error)})))


(defn load-conv-update [filename]
  (read-vectorz-edn (slurp filename)))


(defn prep-for-uploading-to-client [results]
  ; XXX - this should really be in conversations I think; not really a util function
  (let [base-clusters (:base-clusters results)
        repness (:base-clusters results)]
    (-> results
      ; remove things we don't want to publish
      (dissoc :mat :rating-mat :opts')

      ; REFORMAT PROJECTION
      ; remove original projection - we'll provide buckets/base-clusters instead
      (dissoc :proj)

      ; REFORMAT BASE CLUSTERS
      (dissoc :base-clusters)
      (dissoc :bid-to-pid)
      (assoc-in [:base-clusters "x"] (map #(first (:center %)) base-clusters))
      (assoc-in [:base-clusters "y"] (map #(second (:center %)) base-clusters))
      (assoc-in [:base-clusters "id"] (map :id base-clusters))
      (assoc-in [:base-clusters "members"] (map :members base-clusters))
      (assoc-in [:base-clusters "count"] (map #(count (:members %)) base-clusters))

      ; REFORMAT REPNESS
      ; make the array position of each cluster imply the cluster id
      (assoc :repness (map :repness (sort-by :id repness))))))


