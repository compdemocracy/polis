(ns polismath.clusters
  (:require [taoensso.timbre.profiling :as profiling
             :refer (pspy pspy* profile defnp p p*)]
            [plumbing.core :as pc
             :refer (fnk map-vals <-)]
            [plumbing.graph :as gr]
            [clojure.tools.trace :as tr]
            [alex-and-georges.debug-repl :as dbr])
  (:refer-clojure :exclude [* - + == /])
  (:use polismath.utils
        polismath.stats
        polismath.named-matrix
        clojure.core.matrix
        clojure.core.matrix.stats
        clojure.core.matrix.operators
        clojure.core.matrix.select))

(set-current-implementation :vectorz)


(defn clst-append
  "Append an item to a cluster, where item is a (mem_id, vector) pair"
  [clst item]
  (assoc clst
         :members (conj (:members clst) (first item))
         :positions (conj (:positions clst) (last item))))


(defn add-to-closest
  "Find the closest cluster and append item (mem_id, vector) to it"
  [clusts item]
  (let [[clst-id clst] (apply min-key
                         (fn [[clst-id clst]]
                           (distance (last item) (:center clst)))
                         clusts)]
    (assoc clusts clst-id
      (clst-append clst item))))


(defn init-clusters
  "Effectively random initial clusters for initializing a new kmeans comp"
  [data k]
  (take k
    (map-indexed
      (fn [id position] {:id id :members [] :center (matrix position)})
      ; Have to make sure we don't have identical cluster centers
      (distinct (rows (get-matrix data))))))


(defn same-clustering?
  "Determines whether clusterings are within tolerance by measuring distances between
  centers. Note that cluster centers here must be vectors and not NDArrays"
  [clsts1 clsts2 & {:keys [threshold] :or {threshold 0.01}}]
  (letfn [(cntrs [clsts] (sort (map :center clsts)))]
    (every?
      (fn [[x y]]
        (< (distance x y) threshold))
      (zip (cntrs clsts1) (cntrs clsts2)))))


(defn cleared-clusters
  "Clears a cluster's members so that new ones can be assoced on a new clustering step"
  [clusters]
  (into {} (map #(vector (:id %) (assoc % :members [])) clusters)))


(defn cluster-step
  "Performs one step of an iterative K-means:
  data-iter: seq of pairs (id, position), eg (pid, person-rating-row)
  clusters: array of clusters"
  [data-iter k clusters]
  (->> data-iter
    ; Reduces a "blank" set of clusters w/ centers into clusters that have elements
    (reduce add-to-closest (cleared-clusters clusters))
    vals
    ; Filter out clusters that don't have any members (should maybe log on verbose?)
    (filter #(> (count (:members %)) 0))
    ; Apply mean to get updated centers
    (map #(-> (assoc % :center (mean (:positions %)))
              (dissoc :positions)))))


(defnp recenter-clusters
  "Replace cluster centers with a center computed from new positions"
  [data clusters]
  (greedy
  (map
    #(assoc % :center (mean (matrix (get-matrix (rowname-subset data (:members %))))))
    clusters)))


(defnp safe-recenter-clusters
  "Replace cluster centers with a center computed from new positions"
  [data clusters]
  (as-> clusters clsts
    ; map every cluster to the newly centered cluster or to nil if there are no members in data
    (p :safe-recenter-map (greedy
    (map
      (fn [clst]
        (let [rns (safe-rowname-subset data (:members clst))]
          (if (empty? (rownames rns))
            nil
            (assoc clst :center (mean (matrix (get-matrix rns)))))))
      clsts)
      ))
    ; Remove the nils, they break the math
    (remove nil? clsts)
    ; If nothing is left, make one great big cluster - so that things don't break in most-distal later
    ; XXX - Should see if there is a cleaner place/way to handle this...
    (if (empty? clsts)
      [{:id (inc (apply max (map :id clusters)))
        :members (rownames data)
        :center (mean (matrix (get-matrix data)))}]
      clsts)
    ; XXX - for profiling
    (greedy clsts)))


(defn merge-clusters [clst1 clst2]
  (let [new-id (:id (max-key #(count (:members %)) clst1 clst2))]
    ; XXX - instead of using mean should really do a weighted thing that looks at # members
    {:id new-id
     :members (into (:members clst1) (:members clst2))
     :center (mean (map :center [clst1 clst2]))}))


(defnp most-distal
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
                          #(vector (distance (get-row-by-name data mem) (:center %)) (:id %))
                          clusters))
                   mem))
              (rownames data)))]
    {:dist dist :clst-id clst-id :id id}))


(defn uniqify-clusters [clusters]
  (reduce
    (fn [clusters clst]
      (let [identical-clst (first (filter #(= (:center clst) (:center %)) clusters))]
        (if identical-clst
          (assoc clusters (typed-indexof clusters identical-clst) (merge-clusters identical-clst clst))
          (conj clusters clst))))
    [] clusters))


(defnp clean-start-clusters
  "This function takes care of some possible messy situations which can crop up with using 'last-clusters'
  in kmeans computation, and generally gets the last set of clusters ready as the basis for a new round of
  clustering given the latest set of data."
  [data clusters k]
  ; First recenter clusters (replace cluster center with a center computed from new positions)
  (let [clusters (into [] (safe-recenter-clusters data clusters))
        ; next make sure we're not dealing with any clusters that are identical to eachother
        uniq-clusters (uniqify-clusters clusters)
        ; count uniq data points to figure out how many clusters are possible
        possible-clusters (min k (count (distinct (rows (get-matrix data)))))]
    (loop [clusters uniq-clusters]
      ; Whatever the case here, we want to do one more recentering
      (let [clusters (recenter-clusters data clusters)]
        (if (> possible-clusters (count clusters))
          ; first find the most distal point, and the cluster to which it's closest
          (let [outlier (most-distal data clusters)]
            (if (> (:dist outlier) 0)
              ; There is work to be done, so do it
              (recur
              (p :usr/inner-clean
                (->
                  ; first remove the most distal point from the cluster it was in;
                  (map
                    (fn [clst]
                      (assoc clst :members
                        (remove (set [(:id outlier)]) (:members clst))))
                    clusters)
                  ; next add a new cluster containing only said point.
                  (conj {:id (inc (apply max (map :id clusters)))
                         :members [(:id outlier)]
                         :center (get-row-by-name data (:id outlier))}))))
              ; Else just return recentered clusters
              clusters))
          ; Else just return recentered clusters
          clusters)))))

 
; Each cluster should have the shape {:id :members :center}
(defnp kmeans
  "Performs a k-means clustering."
  [data k & {:keys [last-clusters max-iters] :or {max-iters 20}}]
  (let [data-iter (zip (rownames data) (matrix (get-matrix data)))
        clusters  (if last-clusters
                    (clean-start-clusters data last-clusters k)
                    (init-clusters data k))]
    (loop [clusters clusters iter max-iters]
      (let [new-clusters (cluster-step data-iter k clusters)]
        (if (or (= iter 0) (same-clustering? clusters new-clusters))
          new-clusters
          (recur new-clusters (dec iter)))))))


(defn dist-matrix
  "Dist matrix"
  ([m] (dist-matrix m m))
  ([m1 m2]
   (matrix
     (map
       (fn [r1]
         (map
           (fn [r2]
             (distance r1 r2))
           m2))
       m1))))


(defn named-dist-matrix
  "Distance matrix with rownames and colnames corresponding to rownames of nm1 and nm2 respectively."
  ([nm] (named-dist-matrix nm nm))
  ([nm1 nm2]
   (named-matrix
     (rownames nm1)
     (rownames nm2)
     (dist-matrix (get-matrix nm1) (get-matrix nm2)))))


(defn silhouette
  "Compute the silhoette coefficient for either a cluster member, or for an entire clustering. Currently,
  the latter just averages over the former for all members - it's likely there is a more efficient way
  to block things up."
  ([distmat clusters member]
   (let [dist-row (rowname-subset distmat [member])
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
                     (colname-subset dist-row data)
                     (get-matrix data)
                     ; This is a 2D row vector; we want 1D, so take first
                     (first data)
                     ; Take the mean of the entries
                     (mean data)
                     (if memb-clst?
                       [data b]
                       [a (min data (or b data))])))))
             [nil nil]
             clusters)]
     ; The actual silhouette computation
     (/ (- b a) (max b a))))
  ([distmat clusters]
   (mean
     (map
       (partial silhouette distmat clusters)
       (rownames distmat)))))


(defn group-members
  "Given group-clusters group and base clusters, get the members for the group"
  [group base-clusters]
  (let [group-bids (set (:members group))]
    (->> base-clusters
         (filter #(group-bids (:id %)))
         (map :members)
         (apply concat))))


(defn- count-votes [votes & [vote]]
  (let [filt-fn (if vote #(= vote %) identity)]
    (count (filter filt-fn votes))))


(defn- initial-comment-stats [vote-col]
  ((gr/eager-compile
     {:na (fnk [votes] (count-votes votes -1))
      :nd (fnk [votes] (count-votes votes  1))
      :ns (fnk [votes] (count-votes votes))
      ; XXX - Change when we flip votes!!!
      :pa (fnk [na ns] (/ (+ 1 na) (+ 2 ns)))
      :pd (fnk [nd ns] (/ (+ 1 nd) (+ 2 ns)))
      :pat (fnk [na ns] (prop-test na ns))
      :pdt (fnk [nd ns] (prop-test nd ns))})
    {:votes vote-col}))


(defn- add-comparitive-stats [in-stats rest-stats]
  (assoc in-stats
    :ra (/ (:pa in-stats)
           (/ (+ 1 (pc/sum :na rest-stats))
              (+ 2 (pc/sum :ns rest-stats))))
    :rd (/ (:pd in-stats)
           (/ (+ 1 (pc/sum :nd rest-stats))
              (+ 2 (pc/sum :ns rest-stats))))
    :rat (two-prop-test (:na in-stats) (pc/sum :na rest-stats)
                        (:ns in-stats) (pc/sum :ns rest-stats))
    :rdt (two-prop-test (:nd in-stats) (pc/sum :nd rest-stats) 
                        (:ns in-stats) (pc/sum :ns rest-stats))))


(defn conv-repness
  ; output legend: n=#, p=prob, r=rep, t=test, a=agree, d=disagree, s=seen
  [data group-clusters base-clusters]
  {:ids (map :id group-clusters)
   :stats
     (->> group-clusters
       ; Base clusters may not be necessary if we use the already compute bucket vote stats
       (mapv (comp columns get-matrix (partial rowname-subset data) #(group-members % base-clusters)))
       (apply
         map
         (fn [& vote-cols-for-groups]
           (->>
             (mapv initial-comment-stats vote-cols-for-groups)
             (mapv-rest add-comparitive-stats)))))})


(defn beats-best-by-test?
  [{:keys [pat rat rdt] :as comment-conv-stats} current-best-z]
  (or (nil? current-best-z)
      (> (max rat rdt) current-best-z)))


(defn passes-by-test?
  [{:keys [pat rat pdt rdt] :as comment-conv-stats}]
  (or (and (z-sig-90? rat) (z-sig-90? pat))
      (and (z-sig-90? rdt) (z-sig-90? pdt))))


(defn finalize-cmt-stats
  [tid {:keys [na nd ns pa pd pat pdt ra rd rat rdt] :as comment-conv-stats}]
  (let [[n-success n-trials p-success p-test repness repness-test repful-for]
         (if (> rat rdt)
           [na ns pa pat ra rat :agree]
           [nd ns pd pdt rd rdt :disagree])]
    {:tid          tid
     :n-success    n-success
     :n-trials     n-trials
     :p-success    p-success
     :p-test       p-test
     :repness      repness
     :repness-test (float repness-test)
     :repful-for   repful-for}))


(defn select-rep-comments
  [{:keys [ids stats] :as repness-stats}]
  ; Reduce statistics into a results hash mapping group ids to rep comments
  (->>
    ; reduce with indices, so we have tids
    (with-indices stats)
    (reduce
      (fn [result [tid comment-stats]]
        ; Inner reduce folds data into result for each group in comment stats
        (reduce
          (fn [inner-result [gid comment-conv-stats]]
            ; Heplper functions for building our result
            (letfn [(ir-get   [ir & ks]
                      (get-in ir (into [gid] ks)))
                    (ir-assoc [ir & ks-and-val] 
                      (assoc-in ir (into [gid] (butlast ks-and-val)) (last ks-and-val)))]
              (as-> inner-result ir
                ; First check to see if the comment data passes, and add if it does
                (if (passes-by-test? comment-conv-stats)
                  (->> comment-conv-stats
                       (finalize-cmt-stats tid)
                       (conj (ir-get ir :sufficient))
                       (ir-assoc ir :sufficient))
                  ir)
                ; Keep track of what the best comment so far is, even if it doesn't pass, so we always have at
                ; least one comment
                (if (and (empty? (ir-get ir :sufficient))
                         (beats-best-by-test? comment-conv-stats (ir-get ir :test)))
                  (ir-assoc ir :best (finalize-cmt-stats tid comment-conv-stats))
                  ir))))
          result
          (zip ids comment-stats)))
      ; initialize result hash
      (into {} (map #(vector % {:best nil :sufficient []}) ids)))
    ; If no sufficient, use best; otherwise sort sufficient and take 5
    (map-vals
      (fn [{:keys [best sufficient]}]
        (if (empty? sufficient)
          [best]
          (->> sufficient
               (sort-by #(- (:repness %)))
               (take 5)))))))


(defn xy-clusters-to-nmat [clusters]
  (let [nmat (named-matrix)]
    (update-nmat
     nmat
     (apply concat ; flatten the list of lists below
      (mapv
       (fn [cluster]
         (let [center (:center cluster)
               id (:id cluster)]
           ; Return some values that we can feed to update-nmat
           [[id :x (first center)]
            [id :y (second center)]]
           ))
       clusters
       )))))


(defn xy-clusters-to-nmat2 [clusters]
  (named-matrix
    (map :id clusters) ; row names
    [:x :y] ; column names
    (matrix (map :center clusters))))


