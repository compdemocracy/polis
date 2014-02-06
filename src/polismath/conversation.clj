(ns polismath.conversation
  (:require [plumbing.core :as plmb]
            [plumbing.graph :as graph])
  (:use polismath.utils
        polismath.pca
        polismath.clusters
        polismath.named-matrix))

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



(def base-conv-update-graph
  {:opts'       (plmb/fnk [opts]
                  "Merge in opts with the following defaults"
                  (merge opts {:n-comps 2
                               :pca-iters 10
                               :cluster-iters 10
                               :base-k 100
                               :group-k 3}))
   :rating-mat  (plmb/fnk [conv votes]
                  (update-nmat (:rating-mat conv)
                    (map #(map % [:pid :tid :vote]) votes)))})


(def small-conv-update-graph
  (merge base-conv-update-graph
    {:mat   (plmb/fnk [rating-mat]
              (map (fn [row] (map #(if (nil? %) 0 %) row))
                (:matrix rating-mat)))
     :pca   (plmb/fnk [conv mat opts']
              (wrapped-pca mat (:n-comps opts')
                           :start-vectors (:pca conv)
                           :iters (:pca-iters conv)))
     :proj  (plmb/fnk [mat pca]
              (pca-project mat pca))
     :group-clusters
            (plmb/fnk [conv rating-mat mat opts']
              (kmeans (assoc rating-mat :matrix mat :cols (map #(str "pc" %) (:n-comps opts')))
                (:group-k opts')
                :last-clusters (:group-clusters conv)
                :cluster-iters (:cluster-iters opts')))
                      }))


;(defn format-conv [conv]
  ;(letfn [(frmt [conv' cmpnt f]
            ;(assoc conv cmpnt (f (conv cmpnt))))]
  ;(-> conv
    ;(frmt :pca #(hash-map :center (:center pca)
                ;:pcs (:pcs pca))
  ;{:last-updated (conv :last-updated)
   ;:base-clusters (


