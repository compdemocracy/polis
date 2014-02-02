(ns polismath.conversation
  (:use polismath.utils))

(defn partial-pca
  [rating-matrix pca indices & {:keys [iters learning-rate]
                                :or {iters 10 learning-rate 0.01}}]
  (let [rating-subset (row-subset rating-matrix indices)
        patial-pca (powerit-pca rating-subset n-comps
                     :start-vectors pca
                     :iters pca-iters)
        forget-rate (- 1 learning-rate)
        partial-update (fn [key] (+ (* forget-rate (pca key)) (partial-pca key)))]
    {:center (partial-update :center)
     :pcs (partial-udpate :pcs)}))

; conv - should have
;   * last-updated
;   * pca
;     * center
;     * pcs
;   * base-clusters
;   * group-clusters
;   * repness
; [hidden]
;   * rating matrix
;   * base-cluster-full [ptpt to base mpa]

(defn update-conv [conv votes & {:keys [n-comps   pca-iters    cluster-iters    base-k     group-k  ]
                                 :or   {n-comps 2 pca-iters 10 cluster-iters 10 base-k 100 group-k 3}}]
  (let [{:keys [last-updated pca base-clusters group-clusters repness]} conv
        rating-matrix (update-rating-matrix rating-matrix
                        (map #(map % [:pid :tid :vote]) votes))
        pca           (powerit-pca rating-matrix n-comps
                                   :start-vectors pca
                                   :iters pca-iters)
        base-clusters (kmeans rating-matrix base-k last-clusters base-clusters)
        group-clusters (kmeans rating-matrix group-k last-clusters group-clusters)
        ptpt-proj     (pca-project rating-matrix ptpt-pca)
        ptpt-clusters {}]
    (conversation rating-matrix ptpt-pca ptpt-clusters)))


;(defn format-conv [conv]
  ;(letfn [(frmt [conv' cmpnt f]
            ;(assoc conv cmpnt (f (conv cmpnt))))]
  ;(-> conv
    ;(frmt :pca #(hash-map :center (:center pca)
                ;:pcs (:pcs pca))
  ;{:last-updated (conv :last-updated)
   ;:base-clusters (


