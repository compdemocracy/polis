;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.math.corr
  (:refer-clojure :exclude [* - + == /])
  (:require
    [taoensso.timbre :as log]
    [taoensso.timbre.profiling :as prof]
    ;[plumbing.core :as pc
    ; :refer (fnk map-vals <-)]
    ;[plumbing.graph :as gr]
    ;[clojure.tools.trace :as tr]
    ;[polismath.utils :as utils]
    ;[polismath.math.stats :as stats]
    [polismath.math.named-matrix :as nm]
    [clojure.spec.alpha :as s]
    [clojure.core.matrix :as matrix]
    ;[clojure.core.matrix.stats :as matrix-stats]
    [clojure.core.matrix.selection :as matrix.selection]
    [clojure.core.matrix.operators :refer :all]
    ;;
    ;[incanter.charts :as charts]
    ;[polismath.conv-man :as conv-man]
    [clojure.set :as set]
    [polismath.components.postgres :as postgres]
    [incanter.stats :as ic-stats]))



;; The following is a naive hclust implementation for clustering comments using the rating matrix.
;; This is so that we can rearrange a correlation matrix according to the hclust ordering for one of them slick heatmap things.
;; This is not a particularly efficient algorithm, but it gets the job done for now.

(defn -hclust
  "Implements the inner recursive agglomeration step for the hclust function."
  ([clusters distances]
   (if (= (count clusters) 1)
     clusters
     (let [[c1 c2] (->> (for [c1 clusters
                              c2 clusters
                              ;; Make sure we don't traverse [c c], or both [x y] and [y x]
                              :when (< (:id c1) (:id c2))]
                          [c1 c2])
                        (apply min-key
                               (fn [[c1 c2]]
                                 (let [key [(:id c1) (:id c2)]]
                                   (if-let [dist (get @distances key)]
                                     dist
                                     (let [dist (matrix/distance (:center c1) (:center c2))]
                                       (swap! distances assoc key dist)
                                       dist))))))
           size (+ (:size c1) (:size c2))
           clusters (-> clusters
                        (->> (remove #{c1 c2}))
                        (conj {:id (inc (apply max (map :id clusters)))
                               :children [c1 c2]
                               :members (concat (:members c1) (:members c2))
                               :distance (get @distances [(:id c1) (:id c2)])
                               :center (/ (+ (* (:size c1) (:center c1))
                                             (* (:size c2) (:center c2)))
                                          size)
                               :size size}))]
       (-hclust clusters))))
  ([clusters]
   (-hclust clusters (atom {}))))


(defn hclust
  "Performs hclust on a named matrix"
  [nmatrix]
  (log/debug "hclust on matrix of shape" (matrix/shape (nm/get-matrix nmatrix)))
  (-hclust
    (mapv (fn [id row]
            {:center row :id id :size 1 :members [id]})
          (nm/rownames nmatrix)
          (matrix/rows (nm/get-matrix nmatrix)))))


(defn flatten-hclust
  "Extracts out the tip/leaf node ordering from the hclust results.
  (This is rendered somewhat irrelevant by the fact that the hclust algorithm now tracks this data using :members attr)"
  [clusters]
  (mapcat
    (fn [cluster]
      (if-let [children (:children cluster)]
        (flatten-hclust children)
        [(:id cluster)]))
    clusters))


(defn blockify-corr-matrix
  "Rearrange the given correlation matrix ({:comments :matrix}) such that"
  [corr-matrix clusters]
  (let [comments (:comments corr-matrix)
        matrix (:matrix corr-matrix)
        members (:members (first clusters))
        member-indices (mapv #(.indexOf comments %) members)]
    {:matrix (matrix.selection/sel matrix member-indices member-indices)
     :comments members}))


;; Need to remove nulls to compute cov/corr

;; Ideally we'd have something like a null senstive implementation of corr/cov? Restrict to overlapping dimensions?
;; What to do about 0 variance comments (all pass/null)?
;; These return NaN; treat as 0?


;; These things really should be in the named matrix namespace?
(defn cleaned-nmat [nmat]
  (nm/named-matrix
    (nm/rownames nmat)
    (nm/colnames nmat)
    (matrix/matrix
      (mapv (fn [row] (map #(or % 0) row))
            (matrix/rows (nm/get-matrix nmat))))))

(defn transpose-nmat [nmat]
  (nm/named-matrix
    (nm/colnames nmat)
    (nm/rownames nmat)
    (matrix/transpose (nm/get-matrix nmat))))

;(defn cleaned-matrix [conv]
;  (mapv (fn [row] (map #(or % 0) row))
;        (matrix/rows (nm/get-matrix (:rating-mat conv)))))


;; The actual correlation matrix stuff


(defn correlation-matrix
  [nmat]
  {:matrix (ic-stats/correlation (matrix/matrix (nm/get-matrix nmat)))
   :comments (nm/colnames nmat)})


;; Here's some stuff for spitting out the actual results.

(require '[cheshire.core :as cheshire])

(defn prepare-hclust-for-export
  [clusters]
  (mapv
    (fn [cluster]
      (-> cluster
          (update :center (partial into []))))
    clusters))


(defn default-tids
  ;; Gonna need to get all of this under group clusters vs subgroups
  [{:as conv :keys [repness consensus group-clusters rating-mat pca]}]
  (let [{:keys [extremity]} pca
        {:keys [agree disagree]} consensus]
    (set
      (concat
        (map :tid (concat agree disagree))
        (mapcat
          (fn [[gid gid-repness]]
            (map :tid gid-repness))
          repness)))))


(defn compute-corr
  ([conv tids]
   (let [matrix (:rating-mat conv)
         subset-matrix (if tids (nm/colname-subset matrix tids) matrix)
         cleaned-matrix (cleaned-nmat subset-matrix)
         transposed-matrix (transpose-nmat cleaned-matrix)
         corr-mat (prof/profile :info :corr-mat (correlation-matrix cleaned-matrix))
         hclusters (prof/profile :info ::hclust (hclust transposed-matrix))
         corr-mat' (blockify-corr-matrix corr-mat hclusters)
         corr-mat'
         ;; Prep for export...
         (update corr-mat' :matrix (comp (partial mapv (fn [row] (into [] row)))
                                         matrix/rows))]
     corr-mat'))
  ([conv]
   (compute-corr conv (default-tids conv))))


(defn spit-json
  [filename data]
  (spit
    filename
    (cheshire/encode data)))

(defn spit-hclust
  [filename clusters]
  (spit-json
    filename
    (prepare-hclust-for-export clusters)))

;; We should add a little clarity on where things are regular matrices vs our {:comments :matrix} matrices for final export...
;; And probably just use named matrices everywhere
(defn spit-matrix
  [filename matrix]
  (spit-json
    filename
    (update matrix :matrix (comp (partial mapv (fn [row] (into [] row)))
                                 matrix/rows))))


;; We have metadata/tags on the argument symbols of function vars
;; So what if we built a macro that copied over entire namespaces of functions to a new ns, but binds them to some sort of default system?
;; System bind!
;; Then you can access a mirror api that has sans-1 arity versions of all the functions, so you don't have to think about system!
;; This could solve the battle between component and mount




(comment
  ;; Here we're putting everything together
  ;; This may not all be 100% correct, as it was copied over from the repl... but I ran through all but the spit and sanity checks pass
  (require '[incanter.charts :as charts]
           '[polismath.runner :as runner]
           '[polismath.conv-man :as conv-man]
           '[polismath.system :as system])
  ;(runner/run! system/base-system {:math-env :preprod})
  ;; Load the data for 15117 (zinvite 2ez5beswtc)
  ;(def focus-id 15117)
  (def focus-zinvite "36jajfnhhn")
  (def focus-id 15228)
  (def conv (conv-man/load-or-init (:conversation-manager runner/system) focus-id))

  (compute-corr conv)
  :ok

  ;conv
  (matrix/shape (nm/get-matrix (:rating-mat conv)))
  ;; Compute hclust on a cleaned, transposed rating matrix
  (def tids (nm/rownames (:rating-mat conv)))
  tids
  (def corr-mat' (compute-corr (:darwin runner/system)))
  ;; Spit this out
  (spit-matrix (str focus-zinvite ".corrmat.json") corr-mat)
  (spit-matrix (str focus-zinvite ".corrmat-whclust.json") corr-mat')
  (spit-hclust (str focus-zinvite ".hclust.json") hclusters)
  ;; All done
  :endcomment)

