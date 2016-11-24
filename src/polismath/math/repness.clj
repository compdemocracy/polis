(ns polismath.math.repness
  (:require [polismath.utils :as utils]
            [polismath.math.stats :as stats]
            [polismath.math.named-matrix :as nm]
            [polismath.math.clusters :as clusters]
            [clojure.core.matrix :as mat]
            [clojure.core.matrix.operators :refer :all]
            [clojure.tools.trace :as tr]
            [plumbing.core :as pc :refer [fnk map-vals <-]]
            [plumbing.graph :as gr])
            ;[alex-and-georges.debug-repl :as dbr]

  (:refer-clojure :exclude [* - + == /]))

(mat/set-current-implementation :vectorz)



(defn- count-votes
  [votes & [vote]]
  "Utility function for counting the number of votes matching `vote`. Not specifying `vote` returns
  length of vote vector."
  (let [filt-fn (if vote #(= vote %) identity)]
    (count (filter filt-fn votes))))


(def comment-stats-graphimpl
  ; The graph implementation is in a closure so that we don't reify classes every time function is called.
  ; This can cause PermGen space crashes. This is used for both consensus and repness comments.
  (gr/eager-compile
    {:na (fnk [votes] (count-votes votes -1))
     :nd (fnk [votes] (count-votes votes  1))
     :ns (fnk [votes] (count-votes votes))
     ; XXX - Change when we flip votes!!!
     :pa (fnk [na ns] (/ (+ 1 na) (+ 2 ns)))
     :pd (fnk [nd ns] (/ (+ 1 nd) (+ 2 ns)))
     :pat (fnk [na ns] (stats/prop-test na ns))
     :pdt (fnk [nd ns] (stats/prop-test nd ns))}))


(defn- comment-stats
  "Vote count stats for a given vote column. This vote column should represent the votes for a specific
  comment and group. Comparisons _between_ groups happen later. See `(doc conv-repness)` for key details."
  [vote-col]
  (comment-stats-graphimpl {:votes vote-col}))


(defn- add-comparitive-stats
  "Builds on results of comment-stats by doing comparisons _between_ groups. Args are
  in group stats (as returned by comment-stats), and list of stats for rest of groups.
  See `(doc conv-repness)` for key details."
  [in-stats rest-stats]
  (assoc in-stats
    :ra (/ (:pa in-stats)
           (/ (+ 1 (pc/sum :na rest-stats))
              (+ 2 (pc/sum :ns rest-stats))))
    :rd (/ (:pd in-stats)
           (/ (+ 1 (pc/sum :nd rest-stats))
              (+ 2 (pc/sum :ns rest-stats))))
    :rat (stats/two-prop-test (:na in-stats) (pc/sum :na rest-stats)
                        (:ns in-stats) (pc/sum :ns rest-stats))
    :rdt (stats/two-prop-test (:nd in-stats) (pc/sum :nd rest-stats) 
                        (:ns in-stats) (pc/sum :ns rest-stats))))


(defn conv-repness
  "Computes representativeness (repness) for a given data set, group clustering and base clustering,
  returned as a map `{:ids __ :stats __}`. The `:stats` key maps to a sequences of results, one for each
  group cluster, each of which is a sequence where the positional index corresponds to a particular
  comment, and each value is a hash-map of statistics for the given group/comment. The hash keys obey the
  following legend:
    n=#, p=prob, r=rep, t=test, a=agree, d=disagree, s=seen
  The :ids key maps to a vector of group ids in the same order they appear in the :stats sequence."
  [data group-clusters base-clusters]
  {:ids (map :id group-clusters)
   :stats
     (->> group-clusters
       ; XXX - Base clusters may not be necessary if we use the already computed bucket vote stats
       ; A vector, where each entry is a column iterator for the matrix subset of the given group
       (mapv (comp mat/columns
                   nm/get-matrix
                   (partial nm/rowname-subset data)
                   #(clusters/group-members % base-clusters)))
       (apply
         map
         (fn [& vote-cols-for-groups]
           (->>
             (mapv comment-stats vote-cols-for-groups)
             (utils/mapv-rest add-comparitive-stats)))))})


(defn- beats-best-by-test?
  "Returns true if a given comment/group stat hash-map has a more representative z score than
  current-best-z. Used for making sure we have at least _one_ representative comment for every group,
  even if none are left over after the more thorough filters."
  [{:keys [rat rdt] :as comment-conv-stats} current-best-z]
  (or (nil? current-best-z)
      (> (max rat rdt) current-best-z)))


(defn- beats-best-agr?
  "Like beats-best-by-test?, but only considers agrees. Additionally, doesn't focus solely on repness,
  but also on raw probability of agreement, so as to ensure that there is some representation of what
  people in the group agree on. Also, note that this takes the current-best, instead of just current-best-z."
  [{:keys [na nd ra rat pa pat ns] :as comment-conv-stats} current-best]
  (cond
   ; Explicitly don't let something that hasn't been voted on at all come into repness
    (= 0 na nd)
    false
    ; If we have a current-best by repness estimate, use the more robust measurement
    (and current-best (> (:ra current-best) 1.0))
        ; XXX - a litte messy, since we're basicaly reimplimenting the repness sort function
    (> (* ra rat pa pat) (apply * (map current-best [:ra :rat :pa :pat])))
    ; If we have current-best, but only by prob estimate, just shoot for something that is generally agreed upon
    current-best
        (> (* pa pat) (apply * (map current-best [:pa :pat])))
    ; Otherwise, accept if either repness or probability look generally good
    :else
        (or (stats/z-sig-90? pat)
            (and (> ra 1.0)
                 (> pa 0.5)))))


(defn- passes-by-test?
  "Decide whether we should count a given comment-conv-stat hash-map as being representative."
  ;; Should set the significance as a input variable or env variable XXX
  [{:keys [pat rat pdt rdt] :as comment-conv-stats}]
  (or (and (stats/z-sig-90? rat) (stats/z-sig-90? pat))
      (and (stats/z-sig-90? rdt) (stats/z-sig-90? pdt))))


(defn finalize-cmt-stats
  "Formats comment/repness stats to be consumable by clients. In particular, chooses between
  agree/disagree as to which is more representative, and populates a more regular structure accordingly."
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


(defn repness-metric
  [{:keys [repness repness-test p-success p-test]}]
  (* repness repness-test p-success p-test))


(defn repness-sort
  [repdata]
  (sort-by
    (comp - repness-metric)
    repdata))


(defn agrees-before-disagrees
  "Always put agrees before disagrees"
  [repdata]
  (concat
    ; Need vector so into appends, not prepends
    (filter #(= :agree (:repful-for %)) repdata)
    (filter #(= :disagree (:repful-for %)) repdata)))


(defn select-rep-comments
  "Selects representative comments based on beats-best-by-test? and passes-by-test?. Always ensures
  there is at least one representative comment for a given cluster. Takes the results of conv-repness
  and returns a map of group cluster ids to representative comments and stats."
  [{:keys [ids stats] :as repness-stats} & [mod-out]]
  ; Reduce statistics into a results hash mapping group ids to rep comments
  (->>
    ; reduce with indices, so we have tids
    (utils/with-indices stats)
    ; Apply moderation
    (remove (comp (set mod-out) first))
    (reduce
      (fn [result [tid stats]]
        ; Inner reduce folds data into result for each group in comment stats
        ; XXX - could this be an assoc-in?
        (reduce
          (fn [group-result [gid comment-conv-stats]]
            ; Heplper functions for building our result; abbrv. gr = group-result
            (letfn [(gr-get   [gr & ks]
                      (get-in gr (into [gid] ks)))
                    (gr-assoc [gr & ks-and-val]
                      (assoc-in gr (into [gid] (butlast ks-and-val)) (last ks-and-val)))]
              (as-> group-result gr
                ; First check to see if the comment data passes, and add if it does
                (if (passes-by-test? comment-conv-stats)
                  (->> comment-conv-stats
                       (finalize-cmt-stats tid)
                       (conj (gr-get gr :sufficient))
                       (gr-assoc gr :sufficient))
                  gr)
                ; Keep track of what the best comment so far is, even if it doesn't pass, so we always have at
                ; least one comment
                (if (and (empty? (gr-get gr :sufficient))
                         (beats-best-by-test? comment-conv-stats (gr-get gr :best :repness-test)))
                  (gr-assoc gr :best (finalize-cmt-stats tid comment-conv-stats))
                  gr)
                ; Also keep track of best agree comment is, so we can throw that the front preferentially
                (if (beats-best-agr? comment-conv-stats (gr-get gr :best-agree))
                  (gr-assoc gr :best-agree (assoc comment-conv-stats :tid tid))
                  gr))))
          result
          (utils/zip ids stats)))
      ; initialize result hash
      (into {} (map #(vector % {:best nil :best-agree nil :sufficient []}) ids)))
    ; If no sufficient, use best; otherwise sort sufficient and take 5
    (map-vals
      (fn [{:keys [best best-agree sufficient]}]
        (let [best-agree (when best-agree
                           ; finalize, and assoc in a :best-agree attribute, so the client can render
                           ; accordingly
                           (assoc (finalize-cmt-stats (:tid best-agree) best-agree)
                                  :n-agree    (:na best-agree)
                                  :best-agree true))
              ; Use best agree if that's what we have; otherwise best (possibly disagree); otherwise nothing
              best-head (cond
                          best-agree [best-agree]
                          best       [best]
                          :else      [])]
          ; If there weren't any matches of the criteria, just take the best match, and take the best agree if
          ; possible, and if not just the best general
          (if (empty? sufficient)
            best-head
            (->> sufficient
                 ; Remove best agree if in list, since we'll be putting it in manually; don't need to do this
                 ; with best, since in any case we'd let it sort itself out
                 (remove #(= (:tid best-agree) (:tid %)))
                 (repness-sort) ; sort by our complicated repness metric
                 (concat (if best-agree [best-agree] [])) ; put best agree at front, if possible
                 (take 5) ; take the top 5
                 (agrees-before-disagrees))))))))


(defn consensus-stats
  [data]
  (->> data
       nm/get-matrix
       mat/columns
       (map comment-stats)
       (map #(assoc %2 :tid %1) (range))))


(defn select-consensus-comments
  [cons-stats & [mod-out]]
  (let [stats (->> cons-stats
                   (remove (comp (set mod-out) :tid))
                   (map
                     (fn [stat]
                       (assoc stat
                              :dm (* (:pd stat) (:pdt stat))
                              :am (* (:pa stat) (:pat stat))))))
        format-stat
              (fn [cons-for stat]
                (let [[n-success p-success p-test] (if (= cons-for :agree)
                                                     [:na :pa :pat]
                                                     [:nd :pd :pdt])]
                  {:tid (:tid stat)
                   :n-success (n-success stat)
                   :n-trials (:ns stat)
                   :p-success (p-success stat)
                   :p-test (p-test stat)}))
        top-5 (fn [cons-for]
                (let [[metric prob test] (if (= cons-for :agree)
                                           [:am :pa :pat]
                                           [:dm :pd :pdt])]
                  (->> stats
                       (filter #(and (> (prob %) 0.5)
                                     (stats/z-sig-90? (test %))))
                       (sort-by (comp - metric))
                       (take 5)
                       (map (partial format-stat cons-for)))))]
    {:agree    (top-5 :agree)
     :disagree (top-5 :disagree)}))

:ok

