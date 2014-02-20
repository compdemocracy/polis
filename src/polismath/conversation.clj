(ns polismath.conversation
  (:require [plumbing.core :as plmb]
            [plumbing.graph :as graph]
            [clojure.core.matrix :as matrix]
;            [clojure.tools.trace :as tr]
            [bigml.sampling.simple :as sampling])
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
  "Base of all conversation updates; handles default update opts and does named matrix updating"
  {:opts'       (plmb/fnk [opts]
                  "Merge in opts with the following defaults"
                  (merge {:n-comps 2
                          :pca-iters 10
                          :base-iters 10
                          :base-k 50
                          :group-iters 10
                          :group-k 3}
                    opts))
   :rating-mat  (plmb/fnk [conv votes]
                  (update-nmat (:rating-mat conv)
                    (map #(map % [:pid :tid :vote]) votes)))})


(def small-conv-update-graph
  "For computing small conversation updates (those without need for base clustering)"
  (merge base-conv-update-graph
    {:mat   (plmb/fnk [rating-mat]
              "swap nils for zeros - most things need the 0s, but repness needs the nils"
              (map (fn [row] (map #(if (nil? %) 0 %) row))
                (:matrix rating-mat)))
     :pca   (plmb/fnk [conv mat opts']
              (wrapped-pca mat (:n-comps opts')
                           :start-vectors (get-in conv [:pca :comps])
                           :iters (:pca-iters opts')))
     :group-clusters
            (plmb/fnk [conv rating-mat mat opts']
              (kmeans (assoc rating-mat :matrix mat)
                (:group-k opts')
                :last-clusters (:group-clusters conv)
                :cluster-iters (:group-iters opts')))
     :proj  (plmb/fnk [mat pca]
              (pca-project mat pca))
     :repness
            (plmb/fnk [rating-mat group-clusters]
              (if (> (count group-clusters) 1)
                (conv-repness rating-mat group-clusters)))}))


(def med-conv-update-graph
  "For computing small conversation updates (those with need of base clustering)"
  (merge small-conv-update-graph
    {:base-clusters
            (plmb/fnk [conv rating-mat mat opts']
              (kmeans (assoc rating-mat :matrix mat)
                (:base-k opts')
                :last-clusters (:base-clusters conv)
                :cluster-iters (:base-iters opts')))
     :proj  (plmb/fnk [base-clusters pca]
              (pca-project (map :center base-clusters) pca))
     :group-clusters
        (plmb/fnk [conv rating-mat base-clusters opts']
          (kmeans (xy-clusters-to-nmat2 base-clusters) (:group-k opts')
                :last-clusters (:group-clusters conv)
                :cluster-iters (:group-iters opts'))
      )}))



(def med-conv-update-graph2
  "For computing small conversation updates (those with need of base clustering). This
  differs from the primary med update graph in that the pca projection happens before the
  base clustering."
  (merge med-conv-update-graph
    {:proj  (plmb/fnk [mat pca]
              (pca-project mat pca))
     :base-clusters
            (plmb/fnk [conv rating-mat proj opts' :as args]
              ; slick code reusability
              ((med-conv-update-graph :base-clusters) (assoc args :mat proj)))}))


(defn partial-pca
  [mat pca indices & {:keys [n-comps iters learning-rate]
                      :or {n-comps 2 iters 10 learning-rate 0.01}}]
  "This function takes in the rating matrix, the current pca and a set of row indices and
  computes the partial pca off of those, returning a lambda that will take the latest PCA 
  and make the update on that in case there have been other mini batch updates since started"
  (let [rating-subset (filter-by-index mat indices)
        part-pca (powerit-pca rating-subset n-comps
                     :start-vectors (:comps pca)
                     :iters iters)
        forget-rate (- 1 learning-rate)]
    (fn [pca']
      "Actual updater lambda"
      (plmb/map-vals #(+ (* forget-rate %1) (* learning-rate %2)) pca' part-pca))))


(defn sample-size-fn [start-y stop-y start-x stop-x]
  (let [slope (/ (- stop-y start-y) (- stop-x start-x))
        start (- (* slope start-x) start-y)]
    (fn [size]
      (min (+ start (* slope size)) stop-y))))
; For now... Will want this constructed with opts eventually
(def sample-size (sample-size-fn 100 1500 1500 150000))


(def large-conv-update-graph
  (merge med-conv-update-graph2
    {:pca (plmb/fnk [conv mat opts']
            (let [n-ptpts (matrix/dimension-count mat 0)
                  sample-size (sample-size n-ptpts)]
              (loop [pca (:pca conv) iter (:pca-iters opts')]
                (let [pca ((partial-pca pca (sampling/sample sample-size)) pca)]
                  (if (= iter 0)
                    (recur pca (dec iter))
                    pca)))))}))


(def small-conv-update (graph/eager-compile small-conv-update-graph))
(def med-conv-update (graph/eager-compile med-conv-update-graph))
(def med-conv-update2 (graph/eager-compile med-conv-update-graph2))
(def large-conv-update (graph/eager-compile large-conv-update-graph))


(defn conv-update [conv votes & {:keys [med-cutoff large-cutoff]
                                 :or {med-cutoff 100 large-cutoff 1000}
                                 :as opts}]
  (let [ptpts   (:row (:rating-mat conv))
        n-ptpts (count (distinct (into ptpts (map :pid votes))))]
    ; dispatch to the appropriate function
    ((cond
;       (< n-ptpts 100)   small-conv-update
;       (< n-ptpts 1000)  med-conv-update
      (< n-ptpts 1500)  med-conv-update2
       :else             large-conv-update)
          {:conv conv :votes votes :opts opts})))


(defn conv-update2 [conv votes opts]
  (let [
        opts'   (assoc (or opts {})
                  :n-comps 2
                  :pca-iters 10
                  :base-iters 10
                  :base-k 50
                  :group-iters 10
                  :group-k 3)
        
;        ptpts   (:row (:rating-mat conv))

;        n-ptpts (count (distinct (into ptpts (map :pid votes))))

        rating-mat (update-nmat
                    (:rating-mat conv)
                    (map #(map % [:pid :tid :vote]) votes))
        
        ;swap nils for zeros - most things need the 0s, but repness needs the nils
        mat (map (fn [row] (map #(if (nil? %) 0 %) row))
                 (:matrix rating-mat))
                 
        pca (wrapped-pca mat (:n-comps opts')
                           :start-vectors (get-in conv [:pca :comps])
                           :iters (:pca-iters opts'))
        
        proj (pca-project mat pca)


        base-clusters 
              (kmeans (assoc rating-mat :matrix proj)
                (:base-k opts')
                :last-clusters (:base-clusters conv)
                :cluster-iters (:base-iters opts'))

        group-k (let [len (count base-clusters)]
                  (cond
                   (< len 3) 1
                   (< len 5) 2
                   (< len 7) 3
                   (< len 15) 4
                   (< len 30) 5
                   :else 6
                  ))

        group-clusters
          (kmeans
            (xy-clusters-to-nmat2 base-clusters)
            group-k
            :last-clusters (:group-clusters conv)
            :cluster-iters (:group-iters opts'))

        repness 
             (if (> (count group-clusters) 1)
               (conv-repness
                rating-mat
                group-clusters
                base-clusters))
        ]
    {
         :rating-mat rating-mat
         :mat mat
         :pca pca
         :proj proj
         :base-clusters base-clusters
         :group-clusters group-clusters
         :repness repness
         }))
