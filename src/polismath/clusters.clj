(ns polismath.clusters
  (:refer-clojure :exclude [* - + == /])
  (:use polismath.utils
        polismath.named-matrix
        clojure.core.matrix
        clojure.core.matrix.stats
        clojure.core.matrix.operators))

(set-current-implementation :vectorz)


(defn init-clusters [data k]
  "Effectively random initial clusters for initializing a new kmeans comp"
  (letfn [(part [coll] (partition k k [] coll))]
    (map-indexed (fn [id [members positions]]
           {:id id :members members :center (mean positions)})
      (zip (part (:rows data)) (part (matrix (:matrix data)))))))


(defn clst-append [clst item]
  "Append an item to a cluster"
  (assoc clst
         :members (conj (:members clst) (first item))
         :positions (conj (:positions clst) (last item))))


(defn same-clustering? [clsts1 clsts2 & {:keys [threshold] :or {threshold 0.01}}]
  "Determines whether clusterings are within tolerance by measuring distances between
  centers. Note that cluster centers here must be vectors and not NDArrays"
  (letfn [(cntrs [clsts] (sort (map :center clsts)))]
    (every?
      (fn [[x y]]
        (< (distance x y) threshold))
      (zip (cntrs clsts1) (cntrs clsts2)))))


(defn cleared-clusters [clusters]
  "Clears a cluster's members so that new ones can be assoced on a new clustering step"
  (into {} (map #(vector (:id %) (assoc % :members [])) clusters)))


(defn cluster-step [data-iter k clusters]
  "Performs one step of an interative K-means:
  data-iter: pairs of (pid ptpt-row)
  clusters: array of clusters"
  (->> data-iter
    ; Reduces a "blank" set of clusters w/ centers into clusters that have elements
    (reduce
      (fn [new-clusters item]
        (let [[clst-id clst] (apply min-key
                       (fn [[clst-id clst]]
                         (distance (last item) (:center clst)))
                       new-clusters)]
          (assoc new-clusters clst-id
            (clst-append clst item))))
      ; Using a dict version of the blank clusters for better indexing
      (cleared-clusters clusters))
    vals
    ; Apply mean to get updated centers
    (map #(-> (assoc % :center (mean (:positions %)))
            (dissoc :positions)))
    ; Filter out clusters that don't hvae any members (should maybe log on verbose?)
    (filter #(> (count (:members %)) 0))))

 
; Each cluster should have the shape {:id :members :center}
(defn kmeans [data k & {:keys [last-clusters max-iters] :or {max-iters 20}}]
  "Performs a k-means clustering."
  (let [data-iter (zip (:rows data) (matrix (:matrix data)))]
    (loop [clusters (or last-clusters (init-clusters data k))
           iter max-iters]
      ; make sure we don't use clusters where k < k
      (let [new-clusters (cluster-step data-iter k clusters)]
        (if (or (= iter 0) (same-clustering? clusters new-clusters))
          new-clusters
          (recur new-clusters (dec iter)))))))


(defn repness [in-part out-part]
  (letfn [(frac-up [votes]
            (let [[up not-up]
                    (reduce
                      (fn [counts vote]
                        (case vote
                          1       (assoc counts 0 (inc (first counts)))
                          (0 -1)  (assoc counts 1 (inc (second counts)))
                          nil     counts))
                      [1 1] votes)]
              (/ up not-up)))]
    (let [in-cols  (columns (:matrix in-part))
          out-cols (columns (:matrix out-part))]
      (map #(/ (frac-up %1) (frac-up %2)) in-cols out-cols))))


(defn conv-repness [data clusters]
  (map
    (fn [cluster]
      (let [row-names (:members cluster)
            in-part  (rowname-subset     data row-names)
            out-part (inv-rowname-subset data row-names)]
        {:id      (:id cluster)
         :repness (repness in-part out-part)}))
    clusters))


