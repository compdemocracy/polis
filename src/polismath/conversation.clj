(ns polismath.conversation
  (:refer-clojure :exclude [* -  + == /])
  (:require [plumbing.core :as plmb]
            [plumbing.graph :as graph]
            [monger.collection :as mc]
            [clojure.core.matrix :as matrix]
            [clojure.tools.trace :as tr]
            [clojure.tools.reader.edn :as edn]
            [clojure.math.numeric-tower :as math]
            [bigml.sampling.simple :as sampling]
           ; [alex-and-georges.debug-repl :as dbr]
            [clojure.tools.logging :as log])
  (:use clojure.core.matrix
        clojure.core.matrix.operators
        polismath.utils
        polismath.pca
        polismath.clusters
        polismath.named-matrix))



(defn new-conv []
  "Minimal structure upon which to perform conversation updates"
  {:rating-mat (named-matrix)})


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
                          :max-k 5
                          :group-iters 10
                          :max-ptpts 80000
                          :max-cmts 800
                          :group-k-buffer 4}
                    opts))

   :zid         (plmb/fnk [conv votes]
                  (or (:zid conv)
                      (:zid (first votes))))

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

   :keep-votes  (plmb/fnk [customs]
                  (:votes customs))

   :rating-mat  (plmb/fnk [conv keep-votes]
                  (update-nmat (:rating-mat conv)
                               (map (fn [v] (vector (:pid v) (:tid v) (:vote v))) keep-votes)))

   :n           (plmb/fnk [rating-mat]
                  (count (rownames rating-mat)))

   :n-cmts      (plmb/fnk [rating-mat]
                  (count (colnames rating-mat)))

   :user-vote-counts
                (plmb/fnk [rating-mat]
                  ; For deciding in-conv below; filter ptpts based on how much they've voted
                  (mapv
                    (fn [rowname row] [rowname (count (remove nil? row))])
                    (rownames rating-mat)
                    (get-matrix rating-mat)))

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
                        in-conv))))
  ; End of base conv update
  })


(defn max-k-fn
  [data max-max-k]
  (min
    max-max-k
    (+ 2
       (int (/ (count (rownames data)) 12)))))


(def small-conv-update-graph
  "For computing small conversation updates (those without need for base clustering)"
  (merge
     base-conv-update-graph
     {:mat (plmb/fnk [rating-mat]
             ; swap nils for zeros - most things need the 0s, but repness needs the nils"
             (greedy
               (map (fn [row] (map #(if (nil? %) 0 %) row))
                 (get-matrix rating-mat))))

      :pca (plmb/fnk [conv mat opts']
             (wrapped-pca mat (:n-comps opts')
                          :start-vectors (get-in conv [:pca :comps])
                          :iters (:pca-iters opts')))

      :proj (plmb/fnk [rating-mat pca]
              (sparsity-aware-project-ptpts (get-matrix rating-mat) pca))

;      :proj (plmb/fnk [mat pca]
              ;(pca-project mat pca))

      :base-clusters
            (plmb/fnk [conv rating-mat proj in-conv opts']
              (greedy
                (let [proj-mat
                        (named-matrix (rownames rating-mat) ["x" "y"] proj)
                      in-conv-mat (rowname-subset proj-mat in-conv)]
                  (sort-by :id
                    (kmeans in-conv-mat
                      (:base-k opts')
                      :last-clusters (:base-clusters conv)
                      :cluster-iters (:base-iters opts'))))))

      :base-clusters-proj
            (plmb/fnk [base-clusters]
              (xy-clusters-to-nmat2 base-clusters))
      
      :bucket-dists
            (plmb/fnk [base-clusters-proj]
              (named-dist-matrix base-clusters-proj))

      :base-clusters-weights
            (plmb/fnk [base-clusters]
              (into {}
                    (map
                      (fn [clst]
                        [(:id clst) (count (:members clst))])
                      base-clusters)))

      ; Compute group-clusters for multiple k values
      :group-clusterings
            (plmb/fnk [conv base-clusters-weights base-clusters-proj opts']
              (into {}
                ; XXX - should test pmap out
                (map
                  (fn [k]
                    [k
                      (sort-by :id
                        (kmeans base-clusters-proj k
                          :last-clusters
                            ; A little pedantic here in case no clustering yet for this k
                            (let [last-clusterings (:group-clusterings conv)]
                              (if last-clusterings
                                (last-clusterings k)
                                last-clusterings))
                          :cluster-iters (:group-iters opts')
                          :weights base-clusters-weights))])
                  (range 2 (inc (max-k-fn base-clusters-proj (:max-k opts')))))))

      ; Compute silhouette values for the various clusterings
      :group-clusterings-silhouettes
            (plmb/fnk [group-clusterings bucket-dists]
              (into {}
                (map
                  (fn [[k clsts]]
                    [k (silhouette bucket-dists clsts)])
                  group-clusterings)))

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

      :bid-to-pid (plmb/fnk [base-clusters]
                    (greedy
                      (map :members (sort-by :id base-clusters))))

      ;; returns {tid {
      ;;           :agree [0 4 2 0 6 0 0 1]
      ;;           :disagree [3 0 0 1 0 23 0 ]}
      ;; where the indices in the arrays correspond NOT directly to the bid, but to the index of the
      ;; corresponding bid in a hypothetically sorted list of the base cluster ids
      :votes-base (plmb/fnk [bid-to-pid rating-mat]
                    (->> rating-mat
                      colnames
                      (map (fn [tid]
                        {:tid tid
                         :A (agg-bucket-votes-for-tid bid-to-pid rating-mat agree? tid)
                         :D (agg-bucket-votes-for-tid bid-to-pid rating-mat disagree? tid)}))
                      (reduce (fn [o entry] (assoc o (:tid entry) (dissoc entry :tid))) {})))

      :repness    (plmb/fnk [rating-mat group-clusters base-clusters]
                    (->> (conv-repness rating-mat group-clusters base-clusters)
                         (select-rep-comments)))

      :consensus  (plmb/fnk [rating-mat]
                    (->> (consensus-stats rating-mat)
                         (select-consensus-comments)))

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
      ; Actual updater lambda"
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
            (let [n-ptpts (matrix/dimension-count mat 0)
                  sample-size (sample-size n-ptpts)]
              (loop [pca (:pca conv) iter (:pca-iters opts')]
                (let [rand-indices (take sample-size (sampling/sample (range n-ptpts) :generator :twister))
                      pca          ((partial-pca mat pca rand-indices) pca)]
                  (if (= iter 0)
                    (recur pca (dec iter))
                    pca)))))}))


(def eager-profiled-compiler
  (comp graph/eager-compile (partial graph/profiled :profile-data)))

(def small-conv-update (eager-profiled-compiler small-conv-update-graph))
(def large-conv-update (eager-profiled-compiler large-conv-update-graph))


(defn conv-update
  "This function dispatches to either small- or large-conv-update, depending on the number
  of participants (as decided by call to sample-size-fn)."
  [conv votes & {:keys [med-cutoff large-cutoff]
                                 :or {med-cutoff 100 large-cutoff 10000}
                                 :as opts}]
  (let [zid     (or (:zid conv) (:zid (first votes)))
        ptpts   (rownames (:rating-mat conv))
        n-ptpts (count (distinct (into ptpts (map :pid votes))))
        n-cmts  (count (distinct (into (rownames (:rating-mat conv)) (map :tid votes))))]
    (log/info (str "Starting conv-update for zid " zid ": N=" n-ptpts ", C=" n-cmts ", V=" (count votes)))
    (->
      ; dispatch to the appropriate function
      ((cond
         (> n-ptpts large-cutoff)   large-conv-update
         :else             small-conv-update)
            {:conv conv :votes votes :opts opts})
      ; Remove the :votes key from customs; not needed for persistence
      (assoc-in [:customs :votes] [])
      (dissoc :keep-votes))))


;(defn mod-uddate
  ;[conv mods]
  ;(let [mod-out (->> mods
                     ;(filter #{-1})
                     ;(map :tid))]
    ;(-> conv
        ;(update-in :rating-mat
                   ;(


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
    {:readers {'mikera.vectorz.Vector matrix
               'mikera.arrayz.NDArray matrix
               'mikera.matrixx.Matrix matrix
               'polismath.named-matrix.NamedMatrix named-matrix-reader}}
    text))


(defn conv-update-dump
  "Write out conversation state, votes, computational opts and error for debugging purposes."
  [conv votes & [opts error]]
  (spit (str "errorconv." (. System (nanoTime)) ".edn")
    (prn-str
      {:conv  (into {}
                (assoc-in conv [:pca :center] (matrix (into [] (:center (:pca conv))))))
       :votes votes
       :opts  opts
       :error (str error)})))


(defn load-conv-update [filename]
  (read-vectorz-edn (slurp filename)))


