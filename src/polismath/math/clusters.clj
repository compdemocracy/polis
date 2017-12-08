;; Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.math.clusters
  (:refer-clojure :exclude [* - + == /])
  (:require [taoensso.timbre.profiling :as prof
             :refer (pspy pspy* profile defnp p p*)]
            [taoensso.timbre :as log]
            [plumbing.core :as pc
             :refer (fnk map-vals <-)]
            [plumbing.graph :as gr]
            [clojure.tools.trace :as tr]
            ; [alex-and-georges.debug-repl :as dbr]
            [polismath.utils :as utils]
            [polismath.math.stats :as stats]
            [polismath.math.named-matrix :as nm]
            [clojure.spec.alpha :as s]
            [clojure.core.matrix :as matrix]
            [clojure.core.matrix.stats :as matrix-stats]
            [clojure.core.matrix.selection :as matrix.selection]
            [clojure.core.matrix.operators :refer :all]))


;; We may want to make formal that it's an int? Cause we add later?
(s/def ::id (constantly true))
(s/def ::members seq?)
(s/def ::center seq?)

(s/def ::cluster
  (s/keys :req-un [::id ::members ::center]))

(s/def ::clustering
  (s/* ::cluster))

(matrix/set-current-implementation :vectorz)


(defn clst-append
  "Append an item to a cluster, where item is a (mem_id, vector) pair"
  [clst item]
  (assoc clst
         ; Note that order is important here, and assumed to be the same for the weighted-mean call in `cluster-step`.
         :members (conj (:members clst) (first item))
         :positions (conj (:positions clst) (last item))))


(defn add-to-closest
  "Find the closest cluster and append item (mem_id, vector) to it"
  [clusts item]
  (let [[clst-id clst] (apply min-key
                         (fn [[clst-id clst]]
                           (matrix/distance (last item) (:center clst)))
                         clusts)]
    (assoc clusts clst-id
      (clst-append clst item))))


(defn init-clusters
  "Effectively random initial clusters for initializing a new kmeans comp"
  [data k]
  (->> data
       nm/get-matrix
       matrix/rows
       vec ;; Have to cast to vec before we can distinct cause rows gives us a matrixlist
       distinct
       (map-indexed
         (fn [id position] {:id id :members [] :center (matrix/matrix position)}))
       (take k)))


(defn same-clustering?
  "Determines whether clusterings are within tolerance by measuring distances between
  centers. Note that cluster centers here must be vectors and not NDArrays"
  [clsts1 clsts2 & {:keys [threshold] :or {threshold 0.01}}]
  (letfn [(cntrs [clsts] (sort (map :center clsts)))]
    (every?
      (fn [[x y]]
        (< (matrix/distance x y) threshold))
      (utils/zip (cntrs clsts1) (cntrs clsts2)))))


(defn cleared-clusters
  "Clears a cluster's members so that new ones can be assoced on a new clustering step"
  [clusters]
  (->> clusters
       (map (fn [cluster]
              [(:id cluster)
               (assoc cluster :members [] :positions [])]))
       (into {})))


(defmulti weighted-mean
  "Compute either the mean or weighted mean (if :weights is passed) of either a matrix or
  named matrix. For a matrix, :weights should be vector, the ith element of which is the
  weight corresponding to row i of mat. For a named matrix, it should be a hash."
  (fn [& args]
    [(matrix/matrix? (first args))
     (matrix/vec? (first args))]))

; It's a matrix
(defmethod weighted-mean [true false]
  [mat & {:keys [weights]}]
  (if weights
    (weighted-mean
      (* (/ (count weights) (pc/sum weights))
         (reduce
           (fn [m [row-i weight]]
             (matrix/multiply-row m row-i weight))
           mat
           (utils/with-indices weights))))
    (matrix-stats/mean (matrix/matrix mat))))

; It's a vector...
(defmethod weighted-mean [false true]
  [v & {:keys [weights]}]
  (if weights
    (/ (matrix/dot weights v) (pc/sum weights))
    (matrix-stats/mean v)))

; It's a named matrix...
(defmethod weighted-mean [false false]
  [nmat & {:keys [weights]}]
  (weighted-mean (nm/get-matrix nmat)
                 :weights
                 (when weights
                   (reduce
                     #(conj %1 (weights %2))
                     []
                     (nm/rownames nmat)))))

;; Rename all above to weighted-mean* for profiling
;(defnp weighted-mean
;  [& args]
;  (apply weighted-mean* args))

(defn cluster-weights
  "Get a weights seq given a cluster with :members and a hash-map of weights. Returns nil
  if hm-weights is falsey."
  [cluster hm-weights]
  (when hm-weights
    (->> (:members cluster)
         (map hm-weights))))


(defn cluster-step
  "Performs one step of an iterative K-means:
  data-iter: seq of pairs (id, position), eg (pid, person-rating-row)
  clusters: array of clusters"
  [data-iter k clusters & {:keys [weights]}]
  (->> data-iter
    ; Reduces a "blank" set of clusters w/ centers into clusters that have elements
    (reduce add-to-closest (cleared-clusters clusters))
    vals
    ; Filter out clusters that don't have any members (should maybe log on verbose?)
    (filter #(> (count (:members %)) 0))
    ; Apply mean to get updated centers
    (map (fn [clst]
           (-> clst
               (assoc :center (weighted-mean (:positions clst)
                                             :weights (cluster-weights clst weights)))
               (dissoc :positions))))))


(defn recenter-clusters
  "Replace cluster centers with a center computed from new positions"
  [data clusters & {:keys [weights]}]
  (map
    (fn [clst]
      (assoc clst :center (weighted-mean (nm/rowname-subset data (:members clst))
                                         :weights weights)))
    clusters))


(defn safe-recenter-clusters
  "Replace cluster centers with a center computed from new positions"
  [data clusters & {:keys [weights]}]
  (as-> clusters clsts
    ; map every cluster to the newly centered cluster or to nil if there are no members in data
    (map
      (fn [clst]
        (let [rns (nm/safe-rowname-subset data (:members clst))]
          (if (empty? (nm/rownames rns))
            nil
            (assoc clst :center (weighted-mean rns :weights weights)))))
      clsts)
    ; Remove the nils, they break the math
    (remove nil? clsts)
    ; If nothing is left, make one great big cluster - so that things don't break in most-distal later
    ; XXX - Should see if there is a cleaner place/way to handle this...
    (if (empty? clsts)
      [{:id (inc (apply max -1 (map :id clusters)))
        :members (nm/rownames data)
        :center (weighted-mean data :weights weights)}]
      clsts)))


(defn merge-clusters [clst1 clst2]
  (let [new-id (:id (max-key #(count (:members %)) clst1 clst2))]
    {:id new-id
     :members (into (:members clst1) (:members clst2))
     :center (weighted-mean (map :center [clst1 clst2])
                            :weights (map (comp count :members) [clst1 clst2]))}))


(defn most-distal
  "Finds the most distal point in all clusters"
  [data clusters]
  (let [[dist clst-id id]
          ; find the maximum dist, clst-id, mem-id triple
        (apply max-key #(get % 0)
          (map
            (fn [mem]
                ; Find the minimum distance, cluster-id pair, and add the member name to the end
              (conj (apply min-key #(get % 0)
                      (map
                        #(vector (matrix/distance (nm/get-row-by-name data mem) (:center %)) (:id %))
                        clusters))
                 mem))
            (nm/rownames data)))]
    {:dist dist :clst-id clst-id :id id}))


(defn uniqify-clusters [clusters]
  (reduce
    (fn [clusters clst]
      (let [identical-clst (first (filter #(= (:center clst) (:center %)) clusters))]
        (if identical-clst
          (assoc clusters (utils/typed-indexof clusters identical-clst) (merge-clusters identical-clst clst))
          (conj clusters clst))))
    [] clusters))


(defn clean-start-clusters
  "This function takes care of some possible messy situations which can crop up with using 'last-clusters'
  in kmeans computation, and generally gets the last set of clusters ready as the basis for a new round of
  clustering given the latest set of data.

  WARNING!!! This function is very slow for building up a new clustering from scratch, and thus for an empty
  clustering we just call out to init-clusters. If you try building off of just a few seed clusters though,
  this function will behave very poorly. This could potentially be optimized for down the road, but for now
  be warned."
  [data clusters k & {:keys [weights]}]
  ; First recenter clusters (replace cluster center with a center computed from new positions)
  (if (seq clusters)
    ;; In most cases, we have existing clusters we want to optimize for as we break things apart, and want
    ;; to break things apart in such a way as to preserve as much structure as possible
    (let [clusters (safe-recenter-clusters data clusters :weights weights)
          ; next make sure we're not dealing with any clusters that are identical to eachother
          uniq-clusters (uniqify-clusters clusters)
          ; count uniq data points to figure out how many clusters are possible
          ;; I don't like the into here, but seems necessary to solve a weird core.matrix issue with lists not having nth
          possible-clusters (min k (count (distinct (into [] (matrix/rows (nm/get-matrix data))))))]
      (loop [clusters uniq-clusters]
        ; Whatever the case here, we want to do one more recentering
        (let [clusters (recenter-clusters data clusters :weights weights)]
          (if (> possible-clusters (count clusters))
            ; first find the most distal point, and the cluster to which it's closest
            (let [outlier (most-distal data clusters)]
              (if (> (:dist outlier) 0)
                ; There is work to be done, so do it
                (recur
                  (->
                    ; first remove the most distal point from the cluster it was in;
                    (mapv
                      (fn [clst]
                        (assoc clst :members
                          (remove (set [(:id outlier)]) (:members clst))))
                      clusters)
                    ; next add a new cluster containing only said point.
                    (conj {:id (inc (apply max (map :id clusters)))
                           :members [(:id outlier)]
                           :center (nm/get-row-by-name data (:id outlier))})))
                ; Else just return recentered clusters
                clusters))
            ; Else just return recentered clusters
            clusters))))
    ;; Otherwise, just initialize a set of dummy clusters
    (do
      (log/warn "Had to initialize clusters from clean-start-clusters. This shouldn't have to happen, and maybe means bidToPid mapping didn't load into new conv.")
      (init-clusters data k))))


(defn setify-members
  [clsts & {:keys [trans] :or {trans identity}}]
  (->> clsts
       (map (pc/fn->> :members (map trans) set))
       (set)))


(defn simplify-clsts
  "Given a clustering, creates a set of member sets. This makes it easy to compare clusters for equality.
  Optional `:trans` keyword args lets you perform a transformation to the member names included in member
  sets."
  [clsts & {:keys [trans] :or {trans identity}}]
  {:members (map
              (pc/fn->> :members (map trans) set)
              clsts)
   :center (map
             (pc/fn->> :center (mapv #(utils/round-to % 4)))
             clsts)})


; Each cluster should have the shape {:id :members :center}
(defn kmeans
  "Performs a k-means clustering."
  [data k & {:keys [last-clusters max-iters weights] :or {max-iters 20}}]
  (let [data-iter (utils/zip (nm/rownames data) (matrix/matrix (nm/get-matrix data)))
        clusters  (if last-clusters
                    (clean-start-clusters data last-clusters k :weights weights)
                    (init-clusters data k))]
    (loop [clusters clusters iter max-iters]
      (let [new-clusters (cluster-step data-iter k clusters :weights weights)]
        (if (or (= iter 0) (same-clustering? clusters new-clusters))
          new-clusters
          (recur new-clusters (dec iter)))))))


(defn dist-matrix
  "Dist matrix"
  ([m] (dist-matrix m m))
  ([m1 m2]
   (matrix/matrix
     (map
       (fn [r1]
         (map
           (fn [r2]
             (matrix/distance r1 r2))
           m2))
       m1))))


(defn named-dist-matrix
  "Distance matrix with rownames and colnames corresponding to rownames of nm1 and nm2 respectively."
  ([nm] (named-dist-matrix nm nm))
  ([nm1 nm2]
   (nm/named-matrix
     (nm/rownames nm1)
     (nm/rownames nm2)
     (dist-matrix (nm/get-matrix nm1) (nm/get-matrix nm2)))))


(defn silhouette
  "Compute the silhoette coefficient for either a cluster member, or for an entire clustering. Currently,
  the latter just averages over the former for all members - it's likely there is a more efficient way
  to block things up. If distmat has distances in it not in clusters, those distances are ignored."
  ([distmat clusters member]
   (let [dist-row (nm/rowname-subset distmat [member])
         [a b]
         (reduce
           (fn [[a b] clst]
             (let [memb-clst? (some #{member} (:members clst))
                   membs (remove #{member} (:members clst))]
                 ; This is a little bit silly, but will basically trigger returning 0 if member is in a
                 ; singleton cluster
               (if (and memb-clst? (empty? membs))
                 (reduced [1 1])
                   ; Otherwise, continue...
                 (as-> membs data
                     ; Subset to just the columns for this clusters
                   (nm/colname-subset dist-row data)
                   (nm/get-matrix data)
                     ; This is a 2D row vector; we want 1D, so take first
                   (first data)
                     ; Take the mean of the entries
                   (matrix-stats/mean data)
                   (if memb-clst?
                     [data b]
                     [a (min data (or b data))])))))
           [nil nil]
           clusters)]
     ; The actual silhouette computation
     (/ (- b a) (max b a))))
  ([distmat clusters]
   (let [cluster-distmat (nm/rowname-subset distmat (mapcat :members clusters))]
     (weighted-mean
       (map
         (partial silhouette distmat clusters)
         (nm/rownames cluster-distmat))))))


(defn group-members
  "Given group-clusters group and base clusters, get the members for the group"
  [group base-clusters]
  (let [group-bids (set (:members group))]
    (->> base-clusters
         (filter #(group-bids (:id %)))
         (map :members)
         (apply concat))))


;; XXX This is a little too opinionated imo; Should just map to center and leave unfolding x y for elsewhere for better generality
(defn fold-clusters
  "Takes clusters -- a seq of maps `{:members :id :center}` -- and transforms into a single map
  `{:id :members :x :y :count}`, where each key points to a seq of the values associated with each
  cluster. In particular, this is what's used to format base clusters for mongo uploading (for the
  sake of compression)."
  [clusters]
  {:id      (map :id clusters)
   :members (map :members clusters)
   :x       (map (comp first :center) clusters)
   :y       (map (comp second :center) clusters)
   :count   (map (comp count :members) clusters)})


(defn unfold-clusters
  "The inverse of `fold-clusters`; takes folded clusters and puts them into standard form.
  i.e. `(= identity (comp unfold-clusters fold-clusters))`"
  [{:keys [members id x y] :as folded-clusters}]
  (map
    (fn [ms id x y]
      {:id id
       :members ms
       :center [x y]})
    members
    id
    x
    y))


(defn xy-clusters-to-nmat [clusters]
  (let [nmat (nm/named-matrix)]
    (nm/update-nmat
     nmat
     (apply concat ; flatten the list of lists below
      (mapv
       (fn [cluster]
         (let [center (:center cluster)
               id (:id cluster)]
           ; Return some values that we can feed to update-nmat
           [[id :x (first center)]
            [id :y (second center)]]))

       clusters)))))


(defn xy-clusters-to-nmat2 [clusters]
  (nm/named-matrix
    (map :id clusters) ; row names
    [:x :y] ; column names
    (matrix/matrix (map :center clusters))))


:ok

