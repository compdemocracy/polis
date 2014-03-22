(ns polismath.utils)


(defn agree? [n]
  (< n 0))


(defn disagree? [n]
  (> n 0))


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


(defmacro endlessly [interval & forms]
  `(doseq [~'x (range)]
     ~@forms
     (Thread/sleep ~interval)))


(defn with-indices [coll]
  (map #(vector %1 %2) (range) coll))


(defn filter-by-index [coll idxs] 
  (->> (with-indices coll)
    (filter #((set idxs) (first %)))
    (map second)))


(defn apply-kwargs [f & args]
  "Takes a function f, any number of regular args, and a final kw-args argument which will be
  splatted in as a final argument"
  (apply (apply partial f (butlast args)) (apply concat (last args))))


(defn use-debuggers []
  "Handy debugging utility for loading in debugging namespaces"
  (require '[alex-and-georges.debug-repl :as dr])
  (require '[clojure.tools.trace :as tr]))


(defn prep-for-uploading-bidToPid-mapping [results]
  {"bidToPid" (:bid-to-pid results)})


(defn prep-for-uploading-to-client [results]
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
      (assoc-in [:base-clusters "x"] (map (fn [x] (first (:center x))) base-clusters))
      (assoc-in [:base-clusters "y"] (map (fn [x] (second (:center x))) base-clusters))
      (assoc-in [:base-clusters "id"] (map :id base-clusters))
      (assoc-in [:base-clusters "members"] (map :members base-clusters))
      (assoc-in [:base-clusters "count"] (map (fn [c] (count (:members c))) base-clusters))

      ; REFORMAT REPNESS
      ; make the array position of each cluster imply the cluster id
      (assoc :repness (map :repness (sort-by :id repness))))))


