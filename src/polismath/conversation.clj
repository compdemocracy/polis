(ns polismath.conversation
  (:require [plumbing.core :as plmb]
            [plumbing.graph :as graph]
            [clojure.core.matrix :as matrix]
            [clojure.tools.trace :as tr]
            [clojure.math.numeric-tower :as math]
            [clojure.tools.reader.edn :as edn]
            [bigml.sampling.simple :as sampling])
  (:use polismath.utils
        polismath.pca
        polismath.clusters
        polismath.named-matrix))


(defn choose-group-k [base-clusters]
  (let [len (count base-clusters)]
                  (cond
                   (< len 99) 3
                   :else 4
                  )))

(defn agg-bucket-votes-for-tid [bid-to-pid rating-mat filter-cond tid]
  (let [idx (.indexOf (:cols rating-mat) tid)
        pid-to-row (zipmap (:rows rating-mat) (range (count (:rows rating-mat))))]
    (if (< idx 0)
      []
      (map ; for each bucket
        (fn [pids]
          (let [person-rows (:matrix rating-mat)]
            (math/abs
              ; add up the votes within the group for the given tid
              (reduce + 0
                ; reove votes you don't want to count
                (filter filter-cond
                  ; get a list of votes for the tid from each person in the group
                  (map
                    (fn [pid] (get (get person-rows (pid-to-row pid)) idx))
                    pids))))))
        bid-to-pid))))

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
                          :group-iters 10}
                    opts))

   :rating-mat  (plmb/fnk [conv votes]
                  (time2 "rating-mat"
                  (update-nmat (:rating-mat conv)
                               (map (fn [v] (vector (:pid v) (:tid v) (:vote v))) votes))))

   :n           (plmb/fnk [rating-mat]
                  "count the participants"
                  (time2 "counting-ptpts"
                    (count (:rows rating-mat))))

   :n-cmts      (plmb/fnk [rating-mat]
                  "count comments"
                  (time2 "counting-comments"
                    (count (:cols rating-mat))))

   :user-vote-counts
                (plmb/fnk [rating-mat votes]
                  "This counts the number of actual votes each user has"
                  (time2 "user-vote-count"
                    (mapv
                      (fn [rowname row] [rowname (count (remove nil? row))])
                      (:rows rating-mat)
                      (:matrix rating-mat))))

   :in-conv     (plmb/fnk [conv user-vote-counts n-cmts]
                  "This keeps track of which ptpts are in the conversation (to be considered
                  for base-clustering) based on home many votes they have. Once a ptpt is in,
                  they will remain in."
                  (let [last-in (or (:in-conv conv) #{})]
                    (into last-in
                      (map first
                        (filter
                          (fn [[rowname cnt]]
                            ; We only start looking at a ptpt if they have rated either all the comments or at
                            ; least 7 if there are more than 7
                            (>= cnt (min 7 n-cmts)))
                          user-vote-counts)))))
                         })


(def small-conv-update-graph
  "For computing small conversation updates (those without need for base clustering)"
  (merge
     base-conv-update-graph
     {:mat (plmb/fnk [rating-mat]
             "swap nils for zeros - most things need the 0s, but repness needs the nils"
             (time2 "mat"
               (greedy
               (map (fn [row] (map #(if (nil? %) 0 %) row))
                 (:matrix rating-mat)))))

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
                ; XXX - Hmm... not a huge deal, but we should dissoc the :cols also
                (let [proj-mat (assoc rating-mat :matrix proj)
                      in-conv-mat (rowname-subset proj-mat in-conv)]
                  (sort-by :id
                    (kmeans in-conv-mat
                      (:base-k opts')
                      :last-clusters (:base-clusters conv)
                      :cluster-iters (:base-iters opts')))))))

       :group-clusters
            (plmb/fnk [conv rating-mat base-clusters opts']
              (time2 "group-clusters"
                (greedy
                (sort-by :id
                  (kmeans (xy-clusters-to-nmat2 base-clusters)
                    (choose-group-k base-clusters)
                    :last-clusters (:group-clusters conv)
                    :cluster-iters (:group-iters opts'))))))

       :bid-to-pid (plmb/fnk [base-clusters]
                     (time2 "bid-to-pid"
                      (greedy
                       (map :members (sort-by :id base-clusters)))))

       ;;; returns {tid {
       ;;;           :agree [0 4 2 0 6 0 0 1]
       ;;;           :disagree [3 0 0 1 0 23 0 ]}
       ;;; where the indices in the arrays are bids
       :votes-base (plmb/fnk [bid-to-pid rating-mat]
                     (time2 "votes-base"
                       (let [tids (:cols rating-mat)]
                         (reduce
                           (fn [o entry]
                             (assoc o (:tid entry) (dissoc entry :tid)))
                           {}
                           (map
                             (fn [tid]
                               ; A for aggree; D for disagree
                               {:tid tid
                                :A (agg-bucket-votes-for-tid bid-to-pid rating-mat agree? tid)
                                :D (agg-bucket-votes-for-tid bid-to-pid rating-mat disagree? tid)})
                             tids)))))
       ; End of large-update
       }))


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
  (merge small-conv-update-graph
    {:pca (plmb/fnk [conv mat opts']
            (let [n-ptpts (matrix/dimension-count mat 0)
                  sample-size (sample-size n-ptpts)]
              (loop [pca (:pca conv) iter (:pca-iters opts')]
                (let [pca ((partial-pca pca (sampling/sample sample-size)) pca)]
                  (if (= iter 0)
                    (recur pca (dec iter))
                    pca)))))}))


(def small-conv-update (graph/eager-compile small-conv-update-graph))
(def large-conv-update (graph/eager-compile large-conv-update-graph))


(defn dump-edn [data]
  (spit (str "errorconv." (. System (nanoTime)) ".edn")
    (prn-str data)))

(defn conv-update [conv votes & {:keys [med-cutoff large-cutoff]
                                 :or {med-cutoff 100 large-cutoff 1000}
                                 :as opts}]
  (println "\nStarting new conv update!")
  (try
    (let [ptpts   (:rows (:rating-mat conv))
          n-ptpts (count (distinct (into ptpts (map :pid votes))))]
      (println "N-ptpts:" n-ptpts)
      ; dispatch to the appropriate function
      ((cond
         (> n-ptpts 9999999999)   large-conv-update
         :else             small-conv-update)
            {:conv conv :votes votes :opts opts}))
    (catch Exception e
      ; XXX - hmm... have to figure out how to deal with this hook in production
      (println "Update Failure:" (.getMessage e))
      (dump-edn {:conv conv :votes votes :opts opts :error (str e)})
      (throw e))))


(defn load-conv-edn [filename]
  (edn/read-string (slurp filename)))


