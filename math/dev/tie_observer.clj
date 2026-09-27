(ns tie-observer
  "Replay-only observations; the engine's returned objects are retained."
  (:require [polismath.math.clusters :as c]
            [polismath.math.named-matrix :as nm]
            [clojure.core.matrix :as m]))

(def ^:dynamic *context* nil)

(defn capture [enabled f]
  (if-not enabled [(f) nil]
    (let [events (atom []) outcomes (atom []) complete (atom true) calls (atom 0) base-ids (atom nil)
          emit (fn [kind subject candidates scores selected threshold]
                 (try
                   (when *context*
                   (if (>= (count @events) 100000) (reset! complete false)
                     (swap! events conj {:scope (first *context*) :call (second *context*)
                       :cluster_bound (nth *context* 2) :kind kind :subject (str subject) :candidates (mapv str candidates)
                       :scores (mapv double scores) :selected selected :threshold threshold})))
                   (catch Exception _ (reset! complete false))))
          original-kmeans c/kmeans original-add c/add-to-closest
          original-same c/same-clustering? original-distal c/most-distal
          result (with-redefs
            [c/kmeans (fn [data k & args]
                        (let [base? (not (:weights (apply hash-map args)))
                              primary? (or base? (= @base-ids (set (nm/rownames data))))]
                          (binding [*context* (when primary? [(if base? "base" "group") (swap! calls inc) (min k (count (nm/rownames data)))])]
                            (let [result (vec (apply original-kmeans data k args))]
                              (when *context*
                                (try (swap! outcomes conj {:scope (first *context*) :call (second *context*)
                                      :clusters (mapv (fn [c] {:id (str (:id c)) :members (vec (sort (map str (:members c))))}) result)})
                                     (catch Exception _ (reset! complete false))))
                              (when base? (reset! base-ids (set (map :id result))))
                              result))))
             c/add-to-closest
             (fn [clusters item]
               (let [result (original-add clusters item)]
                 (try
                   (let [ids (vec (keys clusters))
                         scores (mapv #(m/distance (last item) (:center (get clusters %))) ids)
                         chosen (first (filter #(not= (:members (get clusters %)) (:members (get result %))) ids))]
                     (emit "min-last" (first item) ids scores (str chosen) nil))
                   (catch Exception _ (reset! complete false)))
                 result))
             c/same-clustering?
             (fn [a b & args]
               (let [result (apply original-same a b args)
                     threshold (get (apply hash-map args) :threshold 0.01)]
                 (try
                   (let [observed
                         (loop [pairs (map vector (sort (map :center a)) (sort (map :center b))) i 0]
                           (if-let [[x y] (first pairs)]
                             (let [distance (m/distance x y)]
                               (emit "lt" (str "convergence:" i) [] [distance] (< distance threshold) threshold)
                               (if (< distance threshold) (recur (rest pairs) (inc i)) false))
                             true))]
                     (when (not= (boolean result) observed) (reset! complete false)))
                   (catch Exception _ (reset! complete false)))
                 result))
             c/most-distal
             (fn [data clusters]
               (let [result (original-distal data clusters)]
                 (try
                   (let [ids (mapv :id clusters) pids (vec (nm/rownames data))
                         near (mapv (fn [pid]
                           (let [scores (mapv #(m/distance (nm/get-row-by-name data pid) (:center %)) clusters)
                                 win (apply min-key #(nth scores %) (range (count scores)))]
                             (emit "min-last" (str "distal-nearest:" pid) ids scores (str (nth ids win)) nil)
                             {:dist (nth scores win) :clst-id (nth ids win) :id pid})) pids)
                         winner (apply max-key :dist near)]
                     (when (not= (select-keys result [:dist :clst-id :id]) winner) (reset! complete false))
                     (emit "max-last" "distal-farthest" pids (mapv :dist near) (str (:id result)) nil)
                     (emit "gt" "split-radius" [] [(:dist result)] (> (:dist result) 0) 0.0))
                   (catch Exception _ (reset! complete false)))
                 result))]
            (f))]
      [result {:schema "polis-decision-trace/1" :complete @complete :events @events :outcomes @outcomes}])))
