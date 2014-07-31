(ns polismath.conversation
  (:refer-clojure :exclude [* -  + == /])
  (:require [plumbing.core :as plmb]
            [plumbing.graph :as graph]
            [clojure.core.matrix :as matrix]
            [clojure.tools.trace :as tr]
            [clojure.tools.reader.edn :as edn]
            [clojure.math.numeric-tower :as math]
            [bigml.sampling.simple :as sampling]
            [alex-and-georges.debug-repl :as dbr])
  (:use clojure.core.matrix
        clojure.core.matrix.operators
        polismath.utils
        polismath.pca
        polismath.clusters
        polismath.named-matrix))


(defn choose-group-k [base-clusters]
  (let [len (count base-clusters)]
    (cond
      (< len 99) 3
      :else 4)))


(defn agg-bucket-votes-for-tid [bid-to-pid rating-mat filter-cond tid]
  (if-let [idx (index (get-col-index rating-mat) tid)]
    ; If we have data for the given comment...
    (let [pid-to-row (zipmap (rownames rating-mat) (range (count (rownames rating-mat))))
          person-rows (get-matrix rating-mat)]
      (map ; for each bucket
        (fn [pids]
          (->> pids
            ; get votes for the tid from each ptpt in group
            (map (fn [pid] (get (get person-rows (pid-to-row pid)) idx)))
            ; filter votes you don't want to count
            (filter filter-cond)
            ; Sum and abs
            (reduce + 0)
            (math/abs)))
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
                  (merge {:n-comps 2
                          :pca-iters 10
                          :base-iters 10
                          :base-k 50
                          :max-k 12
                          :group-iters 10}
                    opts))

   :rating-mat  (plmb/fnk [conv votes]
                  (time2 "rating-mat"
                  (update-nmat (:rating-mat conv)
                               (map (fn [v] (vector (:pid v) (:tid v) (:vote v))) votes))))

   :n           (plmb/fnk [rating-mat]
                  "count the participants"
                  (time2 "counting-ptpts"
                    (count (rownames rating-mat))))

   :n-cmts      (plmb/fnk [rating-mat]
                  "count comments"
                  (time2 "counting-comments"
                    (count (colnames rating-mat))))

   :user-vote-counts
                (plmb/fnk [rating-mat votes]
                  "This counts the number of actual votes each user has"
                  (time2 "user-vote-count"
                    (mapv
                      (fn [rowname row] [rowname (count (remove nil? row))])
                      (rownames rating-mat)
                      (get-matrix rating-mat))))

   :in-conv     (plmb/fnk [conv user-vote-counts n-cmts]
                  "This keeps track of which ptpts are in the conversation (to be considered
                  for base-clustering) based on how many votes they have. Once a ptpt is in,
                  they will remain in."
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
                        (->> (apply dissoc user-vote-counts in-conv)
                          (sort-by (comp - second))
                          (map first)
                          (take (- greedy-n n-in-conv))
                          (into in-conv))
                        in-conv))))
  ; End of base conv update
  })


(defn max-k-fn
  [data max-max-k]
  (min max-max-k
    (max 2
      (int (/ (count (rownames data)) 3)))))


(def small-conv-update-graph
  "For computing small conversation updates (those without need for base clustering)"
  (merge
     base-conv-update-graph
     {:mat (plmb/fnk [rating-mat]
             "swap nils for zeros - most things need the 0s, but repness needs the nils"
             (time2 "mat"
               (greedy
               (map (fn [row] (map #(if (nil? %) 0 %) row))
                 (get-matrix rating-mat)))))

      :pca (plmb/fnk [conv mat opts']
             (time2 "pca"
               (wrapped-pca mat (:n-comps opts')
                            :start-vectors (get-in conv [:pca :comps])
                            :iters (:pca-iters opts'))))

      :proj (plmb/fnk [mat pca]
              (time2 "proj" (pca-project mat pca)))

      :base-clusters
            (plmb/fnk [conv rating-mat proj in-conv opts']
              (time2 "base-clusters"
                (greedy
                (let [proj-mat
                        (named-matrix (rownames rating-mat) ["x" "y"] proj)
                      in-conv-mat (rowname-subset proj-mat in-conv)]
                  (sort-by :id
                    (kmeans in-conv-mat
                      (:base-k opts')
                      :last-clusters (:base-clusters conv)
                      :cluster-iters (:base-iters opts')))))))

      :base-clusters-proj
            (plmb/fnk [base-clusters]
              (xy-clusters-to-nmat2 base-clusters))
      
      :bucket-dists
            (plmb/fnk [base-clusters-proj]
              (time2 "bucket-dists"
                (named-dist-matrix base-clusters-proj)))

      ; Compute group-clusters for multiple k values
      :group-clusterings
            (plmb/fnk [conv base-clusters-proj opts']
              (into {}
                ; XXX - should test pmap out
                (map
                  (fn [k]
                    [k
                      (sort-by :id
                        (time2 (str "group-clusters-k=" k)
                        (kmeans base-clusters-proj k
                          :last-clusters
                            ; A little pedantic here in case no clustering yet for this k
                            (let [last-clusterings (:group-clusterings conv)]
                              (if last-clusterings
                                (last-clusterings k)
                                last-clusterings))
                          :cluster-iters (:group-iters opts'))))])
                  (range 2 (inc (max-k-fn base-clusters-proj (:max-k opts')))))))

      ; Compute silhouette values for the various clusterings
      :group-clusterings-silhouettes
            (plmb/fnk [group-clusterings bucket-dists]
              (into {}
                (map
                  (fn [[k clsts]]
                    [k (silhouette bucket-dists clsts)])
                  group-clusterings)))

      ; Here we just pick the best K value, based on silhouette
      :group-clusters
            (plmb/fnk [group-clusterings group-clusterings-silhouettes]
              (get group-clusterings
                (max-key group-clusterings-silhouettes (keys group-clusterings))))

      :bid-to-pid (plmb/fnk [base-clusters]
                     (time2 "bid-to-pid"
                      (greedy
                       (map :members (sort-by :id base-clusters)))))

      ;; returns {tid {
      ;;           :agree [0 4 2 0 6 0 0 1]
      ;;           :disagree [3 0 0 1 0 23 0 ]}
      ;; where the indices in the arrays are bids
      :votes-base (plmb/fnk [bid-to-pid rating-mat]
                     (time2 "votes-base"
                       (->> rating-mat
                          colnames
                          (map (fn [tid]
                             {:tid tid
                              :A (agg-bucket-votes-for-tid bid-to-pid rating-mat agree? tid)
                              :D (agg-bucket-votes-for-tid bid-to-pid rating-mat disagree? tid)}))
                          (reduce (fn [o entry] (assoc o (:tid entry) (dissoc entry :tid)))))))

     ; End of large-update
     }))


(defn partial-pca
  "This function takes in the rating matrix, the current pca and a set of row indices and
  computes the partial pca off of those, returning a lambda that will take the latest PCA 
  and make the update on that in case there have been other mini batch updates since started"
  [mat pca indices & {:keys [n-comps iters learning-rate]
                      :or {n-comps 2 iters 10 learning-rate 0.01}}]
  (let [rating-subset (filter-by-index mat indices)
        part-pca (powerit-pca rating-subset n-comps
                     :start-vectors (:comps pca)
                     :iters iters)
        forget-rate (- 1 learning-rate)
        learn (fn [old-val new-val]
                (let [old-val (join old-val (repeat (- (dimension-count new-val 0)
                                                       (dimension-count old-val 0)) 0))]
                  (+ (* forget-rate old-val) (* learning-rate new-val))))]
    (fn [pca']
      "Actual updater lambda"
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
; For now... Will want this constructed with opts eventually
(def sample-size (sample-size-fn 100 1500 1500 150000))


(def large-conv-update-graph
  "Same as small-conv-update-graph, but uses mini-batch PCA"
  (merge small-conv-update-graph
    {:pca (plmb/fnk [conv mat opts']
            (time2 "mb-pca"
            (let [n-ptpts (matrix/dimension-count mat 0)
                  sample-size (sample-size n-ptpts)]
              (loop [pca (:pca conv) iter (:pca-iters opts')]
                (let [rand-indices (take sample-size (sampling/sample (range n-ptpts) :generator :twister))
                      pca          ((partial-pca mat pca rand-indices) pca)]
                  (if (= iter 0)
                    (recur pca (dec iter))
                    pca))))))}))


(def small-conv-update (graph/eager-compile small-conv-update-graph))
(def large-conv-update (graph/eager-compile large-conv-update-graph))


(declare conv-update-dump)
(defn conv-update
  "This function dispatches to either small- or large-conv-update, depending on the number
  of participants (as decided by call to sample-size-fn)."
  [conv votes & {:keys [med-cutoff large-cutoff]
                                 :or {med-cutoff 100 large-cutoff 10000}
                                 :as opts}]
  (println "\nStarting new conv update!")
  (try
    (let [ptpts   (rownames (:rating-mat conv))
          n-ptpts (count (distinct (into ptpts (map :pid votes))))]
      (println "N-ptpts:" n-ptpts)
      ; dispatch to the appropriate function
      ((cond
         (> n-ptpts large-cutoff)   large-conv-update
         :else             small-conv-update)
            {:conv conv :votes votes :opts opts}))
    (catch Exception e
      ; XXX - hmm... have to figure out how to deal with this hook in production. Shouldn't save things to
      ; disk that are too big, and in fact won't be able to save to disk at all on heroku
      (println "Update Failure:" (.getMessage e))
      (conv-update-dump conv votes opts e)
      (throw e))))


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
  ;(clojure.core/read-string
    {:readers {'mikera.vectorz.Vector matrix
               'mikera.arrayz.NDArray matrix
               'mikera.matrixx.Matrix matrix
               'polismath.named-matrix.NamedMatrix named-matrix-reader}}
    text))


(defn conv-update-dump [conv votes & [opts error]]
  (spit (str "errorconv." (. System (nanoTime)) ".edn")
    ; XXX - not sure if the print-method calls will work just in this namespace or not...
    (prn-str
      {:conv  (into {}
                (assoc-in conv [:pca :center] (matrix (into [] (:center (:pca conv))))))
       :votes votes
       :opts  opts
       :error (str error)})))


(defn load-conv-update [filename]
  (read-vectorz-edn (slurp filename)))


