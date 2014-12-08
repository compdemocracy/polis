(ns polismath.simulation
;(ns user
  (:require [clojure.newtools.cli :refer [parse-opts]]
            [clojure.string :as string]
            [bigml.sampling [reservoir :as reservoir]
                            [simple :as simple]]
            [taoensso.timbre.profiling :as profiling
              :refer (pspy pspy* profile defnp p p*)])
  (:use polismath.utils
        ;alex-and-georges.debug-repl
        polismath.named-matrix
        polismath.conversation
        clj-time.coerce
        plumbing.core
        clj-time.local))


(defn random-votes [n-ptpts n-cmts & {:keys [n-votes n-convs] :or {n-convs 1}}]
  (let [n-votes (or n-votes (* n-convs n-ptpts n-cmts))]
    (letfn [(generator [wrapper-fn range]
              (take n-votes (repeatedly #(wrapper-fn (rand-int range)))))]
      (map #(hash-map :zid %1 :pid %2 :tid %3 :vote %4)
        (generator identity n-convs)
        (generator identity n-ptpts)
        (generator identity n-cmts)
        (generator #(- % 1) 3)))))


(defnk make-vote-gen
  "This function creates an infinite sequence of reations which models an increasing number of comments and
  people over time, over some number of conversations n-convs. The start-n argument sets the initial number of
  ptpts and cmts per conversation."
  [person-count-start person-count-growth comment-count-start comment-count-growth n-convs vote-rate]
  (mapcat
    #(random-votes %1 %2 :n-convs n-convs :n-votes vote-rate)
    (map #(+ person-count-start (* person-count-growth %)) (range))
    (map #(+ comment-count-start (* comment-count-growth %)) (range))))


(defn random-poll
  "This is specifically structured to be a drop in replacement for the postgres poll"
  [db-spec last-timestamp generator-args]
  (letfn [(rand-timestamp []
            (+ last-timestamp
               (rand-int (- (to-long (local-now)) last-timestamp))))]
    (sort-by :created
      (map #(assoc % :created (rand-timestamp)) (apply random-votes generator-args)))))


(defprotocol Voteable
  (cast-vote! [this] [this cmnt] [this member cmnt]))


(defrecord CommentVoteDist
  [p-agree p-disagree]
  Voteable
  (cast-vote! [_]
    (let [r (rand)]
      (cond
        (> r p-agree) -1
        (> r (+ p-agree p-disagree)) 1
        :else 0))))


(defn comment-vote-dist!
  "A somewhat bimodal random vote distribution generator. Could be more principaled about this, but I think
  it's fine for starters."
  ([]
   (let [p1 (rand)
         p2 (rand (- 1 p1))
         p1-for-aggree (= (rand-int 2) 0)
         p-agree (if p1-for-aggree p1 p2)
         p-disagree (if p1-for-aggree p2 p1)]
     (CommentVoteDist. p-agree p-disagree)))
  ([p-agree]
   (let [p-disagree (rand (- 1 p-agree))]
     (CommentVoteDist. p-agree p-disagree)))
  ([p-agree p-disagree]
   (assert (<= (+ p-agree p-disagree) 1))
   (CommentVoteDist. p-agree p-disagree)))


(defrecord Group
  [comment-dists]
  Voteable
  (cast-vote! [_ cmnt]
    (cast-vote! (get comment-dists cmnt))))


(defn new-group []
  (Group. []))


(defn grp-add-cmnt
  [grp & {:keys [dist]}]
  (update-in grp [:comment-dists] conj (or dist (comment-vote-dist!))))


(defn random-grp-i
  [grp-dists]
  (first
    (simple/sample (range (count grp-dists))
                   :weight grp-dists)))


(defn add-member
  [conv & [grp-i]]
  (let [member (count (:members conv))]
    (-> conv
        (update-in [:members] conj (or grp-i (random-grp-i (:grp-dists conv))))
        (update-in [:unvoted] into (for [c (range (:comments conv))] [member c])))))


(defn conv-add-cmnt
  [conv]
  (let [cmnt (:comments conv)]
    (-> conv
        (update-in [:groups] (partial mapv grp-add-cmnt))
        (update-in [:unvoted] into (for [m (range (count (:members conv)))] [m cmnt]))
        (update-in [:comments] inc))))


(defn fn-exp
  [f n]
  (apply comp (repeat n f)))


(defn add-members
  [conv n]
  ((fn-exp add-member n) conv))


(defn add-cmnts
  [conv n]
  ((fn-exp conv-add-cmnt n) conv))


(defn sim-conv
  [& {:keys [zid n-grps grp-dists n-ptpts n-cmnts] :or {n-grps 3 n-ptpts 0 n-comnts 0}}]
  (-> {:zid (or zid (rand-int 1000))
       :groups (repeat n-grps (new-group))
       :unvoted []
       :members [] ; actually a map of member indices to group indices
       :comments 0
       :grp-dists (or grp-dists (repeat n-grps (/ 1 n-grps)))}
      (add-members n-ptpts)
      (add-cmnts n-cmnts)))


(defn conv-votes
  [conv & [n]]
  (let [n (or n 1)]
    (let [zid (:zid conv)
          picks (reservoir/sample (:unvoted conv) n)
          new-conv (update-in conv [:unvoted] (partial remove (set picks)))
          ; Handle the situation where we want more votes than there are :unvoted (ptpt, cmnt) pairs by having
          ; revotes
          picks (if (= (count picks) n)
                  picks
                  (concat picks (for [_ (range (- n (count picks)))]
                                  [(rand-int (count (:members conv)))
                                   (rand-int (:comments conv))])))
          votes (map
                  (fn [[m c]]
                    (let [grp-i (get-in conv [:members m])
                          grp ((:groups conv) grp-i)]
                      {:zid zid :pid m :tid c :vote (cast-vote! grp c)}))
                  picks)]
      ; Return the new conversation state so it can be looped on
      [new-conv votes])))


(defprotocol Pollable
  (poll! [this state last-timestamp]))


(defn unzip
  [xys]
  (reduce
    (fn [[xs ys] xy]
      [(conj xs (first xy)) (conj ys (second xy))])
    [[] []]
    xys))


(defn rand-ms
  [max]
  (+ (* (rand-int (int (/ max 1000)))
        1000)
     (rand-int 1000)))



(defn add-timestamps
  [[conv votes] last-timestamp]
  (let [old-last-ts (or last-timestamp 0)
        now (System/currentTimeMillis)
        ts-diff (- now old-last-ts)]
    [conv
     (map #(assoc % :created (+ (rand-ms ts-diff) old-last-ts)) votes)]))


(defn new-poller
  "Takes a collection of conversation simulators, and a set of growth functions, each of which takes an argument of
  the conversation sims, and uses infomation there to decide how to modify the conversation and how to poll"
  [& {:keys [ptpt-growth-fn
             cmnt-growth-fn
             poll-count-fn]}]
  (reify
    Pollable
    (poll! [this conv last-timestamp]
      (let [[new-ptpts new-cmnts n-votes] (map #(% conv) [ptpt-growth-fn cmnt-growth-fn poll-count-fn])]
        (-> conv
            ((fn-exp add-member new-ptpts))
            ((fn-exp conv-add-cmnt new-cmnts))
            (conv-votes n-votes)
            ; Adds :created timestamps
            (add-timestamps last-timestamp))))))


(def simple-poller
  (new-poller
    :ptpt-growth-fn (fn [conv] 10)
    :cmnt-growth-fn (fn [conv] 1)
    :poll-count-fn (fn [conv]
                     (+ 10 (int (/ (* (:comments conv) (inc (count (:members conv))))
                                10))))))


(defn comp-poller
  [& pollers]
  (reify
    Pollable
    (poll! [this convs last-timestamp]
      (let [[new-convs vote-batches]
              (unzip
                (map #(poll! %1 %2 last-timestamp) pollers convs))]
        [new-convs
         (->> vote-batches
              (apply concat)
              (sort-by :created))]))))


(defn int-opt [& args]
  (conj (into [] args)
    :parse-fn #(Integer/parseInt %)))


(def cli-options
  [(int-opt "-i" "--poll-interval INTERVAL" "Milliseconds between randomly generated polls" :default 1500)
   (int-opt "-r" "--vote-rate RATE" "Number of new votes every iteration" :default 10)
   (int-opt "-z" "--n-convs NUMBER" "Number of conversations to simulate" :default 3)
   (int-opt "-p" "--person-count-start COUNT" :default 4)
   (int-opt "-P" "--person-count-growth COUNT" :default 3)
   (int-opt "-c" "--comment-count-start COUNT" :default 3)
   (int-opt "-C" "--comment-count-growth COUNT" :default 1)
   ["-h" "--help"]])


(defn usage [options-summary]
  (->> ["Polismath simulations"
        "Usage: lein run -m polismath.simulation [options]"
        ""
        "Options:"
        options-summary]
   (string/join \newline)))


(defn conv-stat-row
  [zid votes conv]
  (str "XXX,"
       zid ","
       (count (:base-clusters conv)) ","
       (count votes) ","
       (count (rownames (:rating-mat conv)))))


(defn endlessly-sim [opts]
  (let [simulator (atom (make-vote-gen opts))
        conversations (atom {})
        vote-rate (:vote-rate opts)]
    (println "XXX,conv,k,votes,ptpts")
    (endlessly (:poll-interval opts)
      (println \newline "POLLING!")
      (let [new-votes (take vote-rate @simulator)
            split-votes (group-by :zid new-votes)]
        (swap! simulator #(drop vote-rate %))
        (doseq [[zid votes] split-votes]
          (swap! conversations
            (fn [convs]
              (assoc convs zid
                (conv-update (or (convs zid) {:rating-mat (named-matrix)}) votes))))
          (let [conv (@conversations zid)]
            (println (conv-stat-row zid votes conv)))
          (println \newline "Conv" zid)
        )))))


(defn -main [& args]
  (println "Starting simulations")
  (let [{:keys [options arguments errors summary]} (parse-opts args cli-options)]
    (cond
      (:help options)   (exit 0 (usage summary))
      (:errors options) (exit 1 (str "Found the following errors:" \newline (:errors options)))
      true              (endlessly-sim options))))


(defn play [& args]
  (let [big-ptpts    2000
        big-comments 200
        a (conv-update {:rating-mat (named-matrix)} (random-votes 100 10))
        a (conv-update a (random-votes big-ptpts big-comments) :max-ptpts 1000 :max-cmts 100)]
    (println "XXX" (:n a) (:n-cmts a))))
    ;(profile :info :clusters
      ;(conv-update a (random-votes big-ptpts (+ big-comments 2)) :large-cutoff 10000 :max-ptpts 10000))


(defn replay-conv-update [filename]
  (let [data (load-conv-update filename)
        {:keys [conv votes opts]} data
        {:keys [rating-mat base-clusters pca]} conv]
    (println "Loaded conv:" filename)
    (println "Dimensions:" (count (rownames rating-mat)) "x" (count (colnames rating-mat)))
    (conv-update conv votes)))


