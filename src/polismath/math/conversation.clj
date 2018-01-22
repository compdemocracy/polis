;; Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.math.conversation
  (:refer-clojure :exclude [* -  + == /])
  (:require
    [polismath.utils :as utils]
    [polismath.math.pca :as pca]
    [polismath.math.clusters :as clusters]
    [polismath.math.repness :as repness]
    [polismath.math.named-matrix :as nm]
    [clojure.core.matrix :as matrix]
    [clojure.spec.alpha :as s]
    [clojure.tools.reader.edn :as edn]
    [clojure.tools.trace :as tr]
    [clojure.math.numeric-tower :as math]
    [clojure.core.matrix :as matrix]
    [clojure.core.matrix.operators :refer :all]
    [plumbing.core :as plmb]
    [plumbing.graph :as graph]
    [bigml.sampling.simple :as sampling]
    ;[alex-and-georges.debug-repl :as dbr]
    [taoensso.timbre :as log]
    [clojure.spec.gen.alpha :as gen]
    [clojure.test.check.generators :as generators]))


;; Starting to spec out our domain model here and build generators for the pieces
;; This will let us do generative testing and all other ilk of awesome things

(defn pos-int [gen-bound]
  (s/with-gen
    (s/and int? pos?)
    (s/gen (s/int-in 0 gen-bound))))

(s/def ::zid (pos-int 20))
(s/def ::tid (pos-int 100))
(s/def ::pid (pos-int 100))
(s/def ::gid (pos-int 8))
;; QUESTION How do we have a generator that gives us monotonically increasing values?
(s/def ::created (s/and int? pos?))
(s/def ::vote #{-1 0 1 -1.0 1.0 0.0})

(s/def ::vote-map
  (s/keys :req-un [::zid ::tid ::pid ::vote ::created]))

(s/def ::maybe-vote (s/or :missing nil? :voted ::vote))

(s/def ::zid int?)
(s/def ::last-vote-timestamp int?)
(s/def ::group-votes
  (constantly true))
(s/def ::sub-group-votes
  (s/map-of ::gid ::group-votes))

(s/def ::group-clusters ::clusters/clustering)
(s/def ::subgroup-clusters
  (s/map-of ::gid ::clusters/clustering))

(s/def ::repness ::repness/clustering-repness)

(s/def ::subgroup-repness
  (s/map-of ::gid ::repness/clustering-repness))

(s/def ::rating-mat
  ;(s/with-gen
    (s/and ::nm/NamedMatrix))
           ;every element is a ::maybe-vote
           ;#(every?))))
  ;; Let's just use a generator that generates votes and places them in a rating mat?
  ;())

(s/def ::raw-rating-mat ::rating-mat)

;; May want to speck out "bare" vs "fleshed out" conversations, as well as loaded vs raw, etc
(s/def ::new-conversation
  (s/keys :req-un [::raw-rating-mat ::last-vote-timestamp]))
(s/def ::full-conversation
  (s/keys :req-un [::zid ::last-vote-timestamp ::group-votes ::raw-rating-mat ::rating-mat ::group-clusters ::subgroup-clusters ::repness ::subgroup-repness]))

(s/def ::conversation
  (s/or :new ::new-conversation
        :full ::full-conversation))


(defn new-conv []
  "Minimal structure upon which to perform conversation updates"
  {:raw-rating-mat (nm/named-matrix)
   :last-vote-timestamp 0
   :lastVoteTimestamp 0
   :rating-mat (nm/named-matrix)})


;; I think this is old and can be removed
;(defn choose-group-k [base-clusters]
;  (let [len (count base-clusters)]
;    (cond
;      (< len 99) 3
;      :else 4)))


(defn agg-bucket-votes-for-tid [bid-to-pid rating-mat filter-cond tid]
  (if-let [idx (nm/index (nm/get-col-index rating-mat) tid)]
    ; If we have data for the given comment...
    (let [pid-to-row (zipmap (nm/rownames rating-mat) (range (count (nm/rownames rating-mat))))
          person-rows (nm/get-matrix rating-mat)]
      (mapv ; for each bucket
        (fn [pids]
          (->> pids
            ; get votes for the tid from each ptpt in group
            (map (fn [pid] (get (get person-rows (pid-to-row pid)) idx)))
            ; filter votes you don't want to count
            (filter filter-cond)
            ; count
            (count)))
        bid-to-pid))
    ; Otherwise return an empty vector
    []))



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
                  ;; TODO Answer and resolve this question:
                  ;; QUESTION Does it make senes to have the defaults here or in the config.edn or both duplicated?
                  (merge {:n-comps 2 ; does our code even generalize to others?
                          :pca-iters 10
                          :base-iters 10
                          :base-k 100
                          :max-k 5
                          :group-iters 10
                          ;; These three in particular we should be able to tune quickly
                          :max-ptpts 100000
                          :max-cmts 1500
                          :group-k-buffer 4}
                    opts))

   :zid         (plmb/fnk [conv votes]
                  (or (:zid conv)
                      (:zid (first votes))))

   :last-vote-timestamp
                (plmb/fnk [conv votes]
                  (apply max
                         (or (:last-vote-timestamp conv) 0)
                         (map :created votes)))

   :customs     (plmb/fnk [conv votes opts']
                  ; Decides whether there is room for new ptpts/cmts, and which votes should be allowed in
                  ; based on which ptpts/cmts have already been seen. This is a simple prevention against
                  ; conversations that get too large. Returns {:pids :tids :votes}, where the first two kv
                  ; pairs are persisted and built upon and persisted; :votes is used downstream and tossed
                  (reduce
                    (fn [{:keys [pids tids] :as result}
                         {:keys [pid  tid]  :as vote}]
                      (let [pid-room (< (count pids) (:max-ptpts opts'))
                            tid-room (< (count tids) (:max-cmts opts'))
                            pid-in   (pids pid)
                            tid-in   (tids tid)]
                        (if (and (or pid-room pid-in)
                                 (or tid-room tid-in))
                          (assoc result
                                 :pids  (conj (:pids result)  pid)
                                 :tids  (conj (:tids result)  tid)
                                 :votes (conj (:votes result) vote))
                          result)))
                    ; Customs collection off which to base reduction; note that votes get cleared out
                    (assoc (or (:customs conv) {:pids #{} :tids #{}})
                      :votes [])
                    votes))

   :keep-votes
   (plmb/fnk [customs]
     (:votes customs))

   :raw-rating-mat
   (plmb/fnk [conv keep-votes]
     (nm/update-nmat
       (:raw-rating-mat conv)
       (map (fn [v] (vector (:pid v) (:tid v) (:vote v))) keep-votes)))

   :rating-mat
   (plmb/fnk [conv raw-rating-mat]
     ;; This if-let here is just a simple performance optimization
     (let [mat
           (if-let [mod-out (:mod-out conv)]
             (nm/zero-out-columns raw-rating-mat mod-out)
             raw-rating-mat)]
       mat))

   :tids
   (plmb/fnk [conv rating-mat]
     (nm/colnames rating-mat))

   :n           (plmb/fnk [rating-mat]
                  (count (nm/rownames rating-mat)))

   :n-cmts      (plmb/fnk [rating-mat]
                  (count (nm/colnames rating-mat)))

   :user-vote-counts
                (plmb/fnk [raw-rating-mat]
                  ; For deciding in-conv below; filter ptpts based on how much they've voted
                  (->> (mapv
                         (fn [rowname row]
                           [rowname (count (remove nil? row))])
                         (nm/rownames raw-rating-mat)
                         (nm/get-matrix raw-rating-mat))
                       (into {})))

   ;; Ugg... right, have to clarify that we don't want to drop this; are we leaving anything else out like this?
   :mod-out
   (plmb/fnk [conv]
     (:mod-out conv))
   :mod-in
   (plmb/fnk [conv]
     (:mod-in conv))
   :meta-tids
   (plmb/fnk [conv]
     (:meta-tids conv))

   ;; There should really be a nice way for us to specify that we want a full recompute on everything except in-conv,
   ;; since in meta-tids we don't want to loose people in that process.
   :in-conv     (plmb/fnk [conv user-vote-counts n-cmts]
                  ; This keeps track of which ptpts are in the conversation (to be considered
                  ; for base-clustering) based on home many votes they have. Once a ptpt is in,
                  ; they will remain in.
                  (as-> (or (:in-conv conv) #{}) in-conv
                    ; Start with whatever you have, and join it with anything that meets the criteria
                    (into in-conv
                      (map first
                        (filter
                          (fn [[rowname cnt]]
                            ; We only start looking at a ptpt if they have rated either all the comments or at
                            ; least 7 if there are more than 7
                            (>= cnt (min 7 n-cmts)))
                          user-vote-counts)))
                    ; If you are left with fewer than 15 participants, take the top most contributing
                    ; participants
                    (let [greedy-n 15
                          n-in-conv (count in-conv)]
                      (if (< n-in-conv greedy-n)
                        (->> user-vote-counts
                          (remove
                            (fn [[k v]] (in-conv k)))
                          (sort-by (comp - second))
                          (map first)
                          (take (- greedy-n n-in-conv))
                          (into in-conv))
                        in-conv))))})
  ; End of base conv update



(defn max-k-fn
  [data max-max-k]
  (min
    max-max-k
    (+ 2
       (int (/ (count (nm/rownames data)) 12)))))

(defn group-votes
  "Returns a map of group-clusters ids to {:votes {<tid> {:A _ :D _ :S _}}} :n maps."
  [group-clusters base-clusters votes-base]
  (let [bid-to-index (zipmap (map :id base-clusters)
                             (range))]
    (into {}
      (map
        (fn [{:keys [id members] :as group-cluster}]
          (letfn [(count-fn [tid vote]
                    (->>
                      members
                      (mapv bid-to-index)
                      (mapv #(((votes-base tid) vote) %))
                      (apply +)))]
            [id
             {:n-members (let [bids (set members)]
                           ; Add up the count of members in each base-cluster in this group-cluster
                           (->> base-clusters
                                (filter #(bids (:id %)))
                                (map #(count (:members %)))
                                (reduce + 0)))
              :votes (plmb/map-from-keys
                       (fn [tid]
                         {:A (count-fn tid :A)
                          :D (count-fn tid :D)
                          :S (count-fn tid :S)})
                       (keys votes-base))}]))
        group-clusters))))


(defn importance-metric
  [A P S E]
  (let [p (/ (+ P 1) (+ S 2))
        a (/ (+ A 1) (+ S 2))]
    (* (- 1 p) (+ E 1) a)))

;; This could be
;; TODO TUNE
(def meta-priority 7)

(defn priority-metric
  [is-meta A P S E]
  ;; We square to deepen our bias
  (matrix/pow
    (if is-meta
      meta-priority
        (* (importance-metric A P S E)
           ;; scale by a factor which lets new comments bubble up
           (+ 1 (* 8 (matrix/pow 2 (/ S -5))))))
    2))


(comment
  ;; testing values
  (float (importance-metric 1 0 1 0))
  (priority-metric false 1 0 1 0)
  (priority-metric false 20 3 20 0)
  (priority-metric false 18 3 20 1)
  :end-comment)

  
(def small-conv-update-graph
  "For computing small conversation updates (those without need for base clustering)"
  (merge
     base-conv-update-graph
     {:mat (plmb/fnk [rating-mat]
             ; swap nils for per column average - most things need the 0s, but repness needs the nils
             (let [mat (nm/get-matrix rating-mat)
                   ;; TODO column-averages should be a separate build task
                   ;; Can toggle here for nil? or (nil or = 0)
                   ;replace? #(or (nil? %) (= 0 %))
                   replace? nil?
                   column-averages
                   (mapv
                     (fn [col]
                       (let [col (remove replace? col)]
                         (double
                           (/ (reduce + col)
                              (count col)))))
                     (matrix/columns mat))]
               (mapv
                 (fn [row]
                   (mapv
                     (fn [i x]
                       (if (replace? x) (get column-averages i) x))
                     (range)
                     row))
                 mat)))
      :pca (plmb/fnk [conv mat opts']
             (let [pca
                   (pca/wrapped-pca mat
                                    (:n-comps opts')
                                    :start-vectors (get-in conv [:pca :comps])
                                    :iters (:pca-iters opts'))
                   cmnt-proj (pca/pca-project-cmnts pca)
                   cmnt-extremity
                   (mapv
                     (fn [row]
                       (matrix/length row))
                     (matrix/rows cmnt-proj))]
               (assoc pca
                      :comment-projection (matrix/transpose cmnt-proj)
                      :comment-extremity cmnt-extremity)))


      :proj
      (plmb/fnk [rating-mat pca]
        (pca/sparsity-aware-project-ptpts (nm/get-matrix rating-mat) pca))

      ;:cmnt-proj
      ;(plmb/fnk [pca]
      ;  (pca/pca-project-cmnts pca))

      ;; QUESTION Just have proj return an nmat?
      :proj-nmat
      (plmb/fnk [rating-mat proj]
        (nm/named-matrix (nm/rownames rating-mat) ["x" "y"] proj))

      :base-clusters
      (plmb/fnk [conv proj-nmat in-conv opts']
        (let [in-conv-mat (nm/rowname-subset proj-nmat in-conv)]
          (sort-by :id
            (clusters/kmeans in-conv-mat
              (:base-k opts')
              :last-clusters (:base-clusters conv)
              :max-iters (:base-iters opts')))))

      :base-clusters-proj
      (plmb/fnk [base-clusters]
        (clusters/xy-clusters-to-nmat2 base-clusters))
      
      :bucket-dists
      (plmb/fnk [base-clusters-proj]
        (clusters/named-dist-matrix base-clusters-proj))

      :base-clusters-weights
      (plmb/fnk [base-clusters]
        (into {}
              (map
                (fn [clst]
                  [(:id clst) (count (:members clst))])
                base-clusters)))


      ;; Here we compute the top level clusters; These are the traditional clusters we've been using for some time now.
      ;; Below we'll use these as the basis for a second level of subgroup clusters

      ; Compute group-clusters for multiple k values
      :group-clusterings
      (plmb/fnk [conv base-clusters-weights base-clusters-proj opts']
          (plmb/map-from-keys
            (fn [k]
              (sort-by :id
                (clusters/kmeans base-clusters-proj k
                  :last-clusters
                    ; A little pedantic here in case no clustering yet for this k
                    (when-let [last-clusterings (:group-clusterings conv)]
                      (last-clusterings k))
                  :cluster-iters (:group-iters opts')
                  :weights base-clusters-weights)))
            (range 2 (inc (max-k-fn base-clusters-proj (:max-k opts'))))))

      ; Compute silhouette values for the various clusterings
      :group-clusterings-silhouettes
      (plmb/fnk [group-clusterings bucket-dists]
        (plmb/map-vals (partial clusters/silhouette bucket-dists) group-clusterings))

      ; This smooths changes in cluster counts (K-vals) by remembering what the last K was, and only changing
      ; after (:group-k-buffer opts') many times on a new K value
      :group-k-smoother
      (plmb/fnk
        [conv group-clusterings group-clusterings-silhouettes opts']
        (let [{:keys [last-k last-k-count smoothed-k] :or {last-k-count 0}}
              (:group-k-smoother conv)
              count-buffer (:group-k-buffer opts')
                           ; Find best K value for current data, given silhouette
              this-k       (apply max-key group-clusterings-silhouettes (keys group-clusterings))
                           ; If this and last K values are the same, increment counter
              same         (if last-k (= this-k last-k) false)
              this-k-count (if same (+ last-k-count 1) 1)
                           ; if seen > buffer many times, switch, OW, take last smoothed
              smoothed-k   (if (>= this-k-count count-buffer)
                             this-k
                             (if smoothed-k smoothed-k this-k))]
          {:last-k       this-k
           :last-k-count this-k-count
           :smoothed-k   smoothed-k}))

      ; Pick the cluster corresponding to smoothed K value from group-k-smoother
      :group-clusters
      (plmb/fnk [group-clusterings group-k-smoother]
        (get group-clusterings
          (:smoothed-k group-k-smoother)))


      ;; Now we're going to do the same thing for subclusters, or 2-level, 2-down hierarchical clustering
      ;; This will more or less look the same, except that we'll have to do it for each group

      ;; Compute subgroup-clusters for each group id, for multiple k values, returning a nested map of:
      ;;     {:group-id {:k [clusters] ...} ...}
      :subgroup-clusterings
      (plmb/fnk [conv base-clusters-weights base-clusters-proj group-clusters opts']
        (into {}
          ;; For each group cluster id
          (map
            (fn [group-cluster]
              (let [gid (:id group-cluster)
                    group-members (:members group-cluster)
                    group-cluster-proj (nm/rowname-subset base-clusters-proj group-members)]
                ;; For each k value...
                ;; TODO Here we should really:
                ;; * not return anyting if group cluster less than 10% (or some such) of population
                ;; * not return anything if group cluster generally too small to subcluster (10?)
                ;; * how do we handle these possibilties downstream?
                [gid
                 (plmb/map-from-keys
                   (fn [k]
                     ;; We sort by id just to have a canonical repr
                     (sort-by
                       :id
                       (clusters/kmeans group-cluster-proj k
                                        ;; This is where we grab the last-clusters from the last update's conv
                                        :last-clusters (get-in conv [:subgroup-clusterings gid k]) ;; ok if nil
                                        ;; TODO: Really need to properly account for what happens when group k changes...
                                        ;; QUESTION: Add subgroup iters? For now assume same parameter value as group; level
                                        :cluster-iters (:group-iters opts')
                                        :weights base-clusters-weights)))
                   (range 2 (inc (max-k-fn group-cluster-proj (:max-k opts')))))]))
            group-clusters)))

      ; Compute silhouette values for the various clusterings
      :subgroup-clusterings-silhouettes
      (plmb/fnk [subgroup-clusterings bucket-dists]
        (plmb/map-vals
          (partial
            plmb/map-vals
            (partial clusters/silhouette bucket-dists))
          subgroup-clusterings))

      ;; Should call this the k-selector:
      ; This smooths changes in cluster counts (K-vals) by remembering what the last K was, and only changing
      ; after (:group-k-buffer opts') many times on a new K value
      :subgroup-k-smoother
      (plmb/fnk
        [conv subgroup-clusterings subgroup-clusterings-silhouettes opts']
        (into {}
          (map
            (fn [[gid group-subgroup-clusterings]]
              (let [group-subgroup-silhouettes (get subgroup-clusterings-silhouettes gid)
                    {:keys [last-k last-k-count smoothed-k] :or {last-k-count 0}}
                    (get-in conv [:subgroup-k-smoother gid])
                    count-buffer (:group-k-buffer opts')
                    ; Find best K value for current data, given silhouette
                    this-k       (apply max-key group-subgroup-silhouettes (keys group-subgroup-clusterings))
                    ; If this and last K values are the same, increment counter
                    same         (if last-k (= this-k last-k) false)
                    this-k-count (if same (+ last-k-count 1) 1)
                    ; if seen > buffer many times, switch, OW, take last smoothed
                    smoothed-k   (if (>= this-k-count count-buffer)
                                   this-k
                                   (if smoothed-k smoothed-k this-k))]
                ;; We return a map of key-value pairs that look like this:
                ;; This is maybe where we could put information about whether the last count matches for the sake of subgroups...
                [gid
                 {:last-k       this-k
                  :last-k-count this-k-count
                  :smoothed-k   smoothed-k}]))
            subgroup-clusterings)))

      ;; This is a little different from the group version above;
      ;; For each group, we take the subgroup clustering the best silhouette, and keep it.
      ;; To each of the clusters in this clustering, we assoc the :parent-id of that cluster.
      ;; We end up with a map that looks like {<parent-id> clusters}, where clusters looks as it does for `:group-clusters`,
      ;; excepting the each cluster has a `:parent-id <parent-id>` attr/value pair.
      :subgroup-clusters
      (plmb/fnk [subgroup-clusterings subgroup-k-smoother]
        (into
          {}
          (map
            (fn [[gid group-subgroup-clusterings]]
              (if-let [smoothed-k (get-in subgroup-k-smoother [gid :smoothed-k])]
                (do
                  (log/debug "Found smoothed-k:" smoothed-k)
                  [gid
                   (map
                     (plmb/fn-> (assoc :parent-id gid))
                     (get group-subgroup-clusterings smoothed-k))])
                (log/warn "Didn't find smoothed-k for gid:" gid)))
            subgroup-clusterings)))



      ;; a vector of member vectors, sorted by base cluster id
      :bid-to-pid (plmb/fnk [base-clusters]
                    (mapv :members (sort-by :id base-clusters)))

      ;; returns {tid {
      ;;           :agree [0 4 2 0 6 0 0 1]
      ;;           :disagree [3 0 0 1 0 23 0 ]}
      ;; where the indices in the arrays correspond NOT directly to the bid, but to the index of the
      ;; corresponding bid in a hypothetically sorted list of the base cluster ids
      :votes-base (plmb/fnk [bid-to-pid raw-rating-mat]
                    (->> raw-rating-mat
                      nm/colnames
                      (plmb/map-from-keys
                        (fn [tid]
                          {:A (agg-bucket-votes-for-tid bid-to-pid raw-rating-mat utils/agree? tid)
                           :D (agg-bucket-votes-for-tid bid-to-pid raw-rating-mat utils/disagree? tid)
                           :S (agg-bucket-votes-for-tid bid-to-pid raw-rating-mat number? tid)}))))


      ;; In most or all of the below, we need to do things for both groups and subgroups. However, the logic for these
      ;; isn't well refactored. There should ideally be some representation of the computations operating on group
      ;; clusters that naturally generalizes or can be applied to the nesting of the subgroup-clusters. However, it also
      ;; raises the question of how we could be structuring the subgroup clusters data differently to facilitate simpler
      ;; provessing. There's some tradeoff between ease of initial processing (dealing with ids and such) and ease of
      ;; downstream processing and data consumption. Will hvae to strike a balance here... For now, again, things are a
      ;; little verbose, but you can hopefully see some of the patters emerging for where these things may generalize.

      ; {gid {:votes {<tid> {A _ D _ S}}}}
      :group-votes
      (plmb/fnk [group-clusters base-clusters votes-base]
        (group-votes group-clusters base-clusters votes-base))
      ;; ?
      :subgroup-votes
      (plmb/fnk [subgroup-clusters base-clusters votes-base]
        (->> subgroup-clusters
             (plmb/map-vals
               (fn [subgroup-clusters']
                 (group-votes subgroup-clusters' base-clusters votes-base)))))


      ; {tid consensus}
      :group-aware-consensus
           (plmb/fnk [group-votes]
             (let [tid-gid-probs
                   (reduce
                     (fn [result [gid gid-stats]]
                       (reduce
                         (fn [result [tid {:keys [A S] :or {A 0 S 0}}]]
                           (let [prob (/ (+ A 1.0) (+ S 2.0))]
                             (assoc-in result [tid gid] prob)))
                         result
                         (:votes gid-stats)))
                       ;; +1 acts as a dumb prior
                     {}
                     group-votes)
                   tid-consensus
                   (plmb/map-vals
                     (fn [tid-stats]
                       (->> tid-stats
                            (map second)
                            (reduce *)))
                     tid-gid-probs)]
               tid-consensus))

      :comment-priorities
      (plmb/fnk [conv group-votes pca tids meta-tids]
        (let [group-votes (:group-votes conv)
              extremities (into {} (map vector tids (:comment-extremity pca)))]
          (plmb/map-from-keys
            (fn [tid]
              (let [{:as total-votes :keys [A D S P]}
                    ;; reduce over votes per group, already aggregated
                    (reduce
                      (fn [votes [gid data]]
                        ;; not sure why we have to do the or here? how would this ever come up nil? small
                        ;; convs?
                        (let [{:as data :keys [A S D] :or {A 0 S 0 D 0}} (get-in data [:votes tid])
                              data (assoc data :P (+ (- S (+ A D))))]
                          ;; Add in each of the data's kv count pairs
                          (reduce
                            (fn [votes' [k v]]
                              (update votes' k + v))
                            votes
                            data)))
                      {:A 0 :D 0 :S 0 :P 0}
                      group-votes)
                    extremity (get extremities tid)]
                (priority-metric (meta-tids tid) A P S extremity)))
            tids)))


      ;; ATTENTION! The following uses of :mod-out should be ideally taking into account strict/vs non-strict
      :repness
      (plmb/fnk [conv rating-mat group-clusters base-clusters]
        (-> (repness/conv-repness rating-mat group-clusters base-clusters)
            (repness/select-rep-comments (:mod-out conv))))
      :subgroup-repness
      (plmb/fnk [conv rating-mat subgroup-clusters base-clusters]
        (->> subgroup-clusters
             (plmb/map-vals
               (fn [subgroup-clusters']
                 (-> (repness/conv-repness rating-mat subgroup-clusters' base-clusters)
                     (repness/select-rep-comments (:mod-out conv)))))))

      :ptpt-stats
      (plmb/fnk [group-clusters base-clusters proj-nmat user-vote-counts]
        (repness/participant-stats group-clusters base-clusters proj-nmat user-vote-counts))
      :subgroup-ptpt-stats
      (plmb/fnk [subgroup-clusters base-clusters proj-nmat user-vote-counts]
        (->> subgroup-clusters
             (plmb/map-vals
               (fn [subgroup-clusters']
                 (repness/participant-stats subgroup-clusters' base-clusters proj-nmat user-vote-counts)))))


      :consensus
      (plmb/fnk [conv rating-mat]
        (-> (repness/consensus-stats rating-mat)
            (repness/select-consensus-comments (:mod-out conv))))

      ; End of large-update
      #_:end}))



(defn partial-pca
  "This function takes in the rating matrix, the current pca and a set of row indices and
  computes the partial pca off of those, returning a lambda that will take the latest PCA 
  and make the update on that in case there have been other mini batch updates since started"
  [mat pca indices & {:keys [n-comps iters learning-rate]
                      :or {n-comps 2 iters 10 learning-rate 0.01}}]
  (let [rating-subset (utils/filter-by-index mat indices)
        part-pca (pca/powerit-pca rating-subset n-comps
                     :start-vectors (:comps pca)
                     :iters iters)
        forget-rate (- 1 learning-rate)
        learn (fn [old-val new-val]
                (let [old-val (matrix/join old-val (repeat (- (matrix/dimension-count new-val 0)
                                                              (matrix/dimension-count old-val 0)) 0))]
                  (+ (* forget-rate old-val) (* learning-rate new-val))))]
    (fn [pca']
      ; Actual updater lambda
      {:center (learn (:center pca') (:center part-pca))
       :comps  (mapv #(learn %1 %2) (:comps pca') (:comps part-pca))})))


(defn sample-size-fn
  "Return a function which decides how many ptpts to sample for mini-batch updates; the input
  parameters correspond to a line of sample sizes to interpolate. Beyon the bounds of these
  points, the sample sizes flatten out so all sample sizes lie in [start-y stop-y]"
  [start-y stop-y start-x stop-x]
  (let [slope (/ (- stop-y start-y) (- stop-x start-x))
        start (- (* slope start-x) start-y)]
    (fn [size]
      (max 
        (long (min (+ start (* slope size)) stop-y))
        start-y))))
; For now... Will want this constructed with opts eventually XXX
(def sample-size (sample-size-fn 100 1500 1500 150000))


(def large-conv-update-graph
  "Same as small-conv-update-graph, but uses mini-batch PCA"
  (merge small-conv-update-graph
    {:pca (plmb/fnk [conv mat opts']
            (let [n-ptpts (matrix/dimension-count mat 0)
                  sample-size (sample-size n-ptpts)]
              (loop [pca (:pca conv) iter (:pca-iters opts')]
                (let [rand-indices (take sample-size (sampling/sample (range n-ptpts) :generator :twister))
                      pca          ((partial-pca mat pca rand-indices) pca)]
                  (if (= iter 0)
                    (recur pca (dec iter))
                    pca)))))}))


(def eager-profiled-compiler
  ;(comp graph/eager-compile (partial graph/profiled :profile-data))
  (comp graph/par-compile (partial graph/profiled :profile-data)))

(def small-conv-update (eager-profiled-compiler small-conv-update-graph))
(def large-conv-update (eager-profiled-compiler large-conv-update-graph))


(defn conv-update
  "This function dispatches to either small- or large-conv-update, depending on the number
  of participants (as decided by call to sample-size-fn)."
  ([conv votes]
   (conv-update conv votes {}))
  ;; TODO Need to pass through these options from all the various places where we call this function...
  ;; XXX Also need to set the max globally and by conversation for plan throttling
  ([conv votes {:keys [large-cutoff]
                :or {large-cutoff 10000}
                :as opts}]
   (let [zid     (or (:zid conv) (:zid (first votes)))
         ptpts   (nm/rownames (:raw-rating-mat conv))
         cmnts   (nm/colnames (:raw-rating-mat conv))
         n-ptpts (count (distinct (into ptpts (map :pid votes))))
         n-cmts  (count (distinct (into cmnts (map :tid votes))))]
     ;; This is a safety measure so we can call conv-update on an empty conversation after adding mod-out
     ;; Note though that as long as we have a non-empty conv, updating with empty/nil votes should still trigger recompute
     (if (and (= 0 n-ptpts n-cmts)
              (empty? votes))
       conv
       (do
         (log/info (str "Starting conv-update for zid " zid ": N=" n-ptpts ", C=" n-cmts ", V=" (count votes)))
         (->
           ; dispatch to the appropriate function
           ((cond
              (> n-ptpts large-cutoff)  large-conv-update
              :else                     small-conv-update)
            {:conv conv :votes votes :opts opts})
           ;; This seems hackish... XXX
           ; Remove the :votes key from customs; not needed for persistence
           (assoc-in [:customs :votes] [])
           (dissoc :keep-votes)))))))



(defn conv-shape
  [conv]
  (matrix/shape (:raw-rating-mat conv)))

(defn not-smaller?
  [conv1 conv2]
  (let [[p1 c1] (conv-shape conv1)
        [p2 c2] (conv-shape conv2)]
    (and (>= p1 p2) (>= c1 c2))))

(s/fdef conv-update
  :args (s/cat :conv ::conversation :votes (s/* ::vote))
  :ret ::full-conversation
  :fn (s/and #(not-smaller? (:ret %) (-> % :args :conv))))

(comment
  (require '[clojure.spec.gen :as gen])
  (gen/generate (s/gen ::conversation))
  :end)



;; TODO The language here, in the poller, the config, the conv structure, etc should all reflect that this isn't just moderation but also is_meta
(defn mod-update
  "Take a conversation record and a seq of moderation data and updates the conversation's mod-out attr"
  [conv mods]
  (try
    ;; We use reduce here instead of a (->> % filter into) because we need to make sure that we are
    ;; processing things in order for mod in then out vs out then in
    (let [mod-out
          (reduce
            (fn [mod-out {:keys [tid is_meta mod]}]
              (if (or is_meta (= mod -1))
                (conj mod-out tid)
                (disj mod-out tid)))
            (set (:mod-out conv))
            mods)
          mod-in
          (reduce
            (fn [mod-in {:keys [tid is_meta mod]}]
              (if (or is_meta (= mod 1))
                (conj mod-in tid)
                (disj mod-in tid)))
            (set (:mod-in conv))
            mods)
          meta-tids
          (reduce
            (fn [meta-tids {:keys [tid is_meta]}]
              (if is_meta
                (conj meta-tids tid)
                (disj meta-tids tid)))
            (set (:meta-tids conv))
            mods)]
      (-> conv
          (assoc :mod-out mod-out
                 :mod-in mod-in
                 :meta-tids meta-tids)
          (update :last-mod-timestamp #(apply max (or % 0) (map :modified mods)))))
    (catch Exception e
      (log/error "Problem running mod-update with mod-out:" (:mod-out conv) "and mods:" mods ":" e)
      (.printStackTrace e)
      conv)))


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
    {:readers {'mikera.vectorz.Vector matrix/matrix
               'mikera.arrayz.NDArray matrix/matrix
               'mikera.matrixx.Matrix matrix/matrix
               'polismath.named-matrix.NamedMatrix nm/named-matrix-reader}}
    text))


(defn conv-update-dump
  "Write out conversation state, votes, computational opts and error for debugging purposes."
  [conv votes & [opts error]]
  (spit (str "errorconv." (. System (nanoTime)) ".edn")
    (prn-str
      {:conv  (into {}
                (assoc-in conv [:pca :center] (matrix/matrix (into [] (:center (:pca conv))))))
       :votes votes
       :opts  opts
       :error (str error)})))


(defn load-conv-update [filename]
  (read-vectorz-edn (slurp filename)))


:ok

