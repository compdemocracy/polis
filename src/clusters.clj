(ns clusters
  (:refer-clojure :exclude [* - + == /])
  (:use utils)
  (:use clojure.core.matrix)
  (:use clojure.core.matrix.stats)
  (:use clojure.core.matrix.operators))

(set-current-implementation :vectorz)


(defn init-clusters [data k]
  "Effectively random initial clusters for initializing a new kmeans comp"
  (letfn [(part [coll] (partition k k [] coll))]
    (map-indexed (fn [id [members positions]]
           {:id id :members members :center (mean positions)})
      (zip (part (:ptpts data)) (part (:matrix data))))))


(defn clst-append [clst item]
  (assoc clst
         :members (conj (:members clst) (first item))
         :positions (conj (:positions clst) (last item))))


; XXX - needs to be fixed...
(defn same-clustering? [clsts1 clsts2 & [threshold]]
  (let [cntrs #(sort (map :center %))]
    (every? identity
      #(< (distance %1 %2) threshold)
      (zip (cntrs clsts1) (cntrs clsts2)))))


(defn cleared-clusters [clusters]
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
                         ;(debug-repl)
                         (distance (last item) (:center clst)))
                       new-clusters)]
          ;(debug-repl)
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

 
; Each cluster should have the shape {:ids :members :center}
(defn kmeans [data k & {:keys [last-clusters max-iters] :or {max-iters 20}}]
  (let [data-iter (zip (:ptpts data) (matrix (:matrix data)))]
    (loop [clusters (or last-clusters (init-clusters data k))
           iter max-iters]
      ; make sure we don't use clusters where k < k
      (let [new-clusters (cluster-step data-iter k clusters)]
        (if (= iter 0)
        ;(if (or (= iter 0) (same-clustering? new-clusters clusters))
          new-clusters
          (recur new-clusters (dec iter)))))))


(def play-data
  {:ptpts  ["a" "b" "c"]
   :cmts   ["x" "y" "z"]
   :matrix [[1 2 3] [4 2 3] [1 2 0]]})

(def clst (init-clusters play-data 2))
(def clst (kmeans play-data 2))

(defn -main []
  (println clst))


