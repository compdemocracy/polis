;; Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.meta.simulation)
;  (:require [polismath.math.conversation :as conversation]
;            [polismath.math.named-matrix :as nm]
;            [polismath.utils :as utils]
;            [clojure.tools.cli :refer [parse-opts]]
;            [clojure.string :as string]
;            [plumbing.core :as pc]
;            [bigml.sampling [reservoir :as reservoir]
;                            [simple :as simple]]
;            [taoensso.timbre.profiling :as profiling :refer (pspy pspy* profile defnp p p*)]
;            ;[taoensso.carmine :as car]
;            ;[taoensso.carmine.message-queue :as car-mq]
;            [clj-time.coerce :as time-coerce]
;            [clj-time.local :as time-local]))
;
;
;(defprotocol Voteable
;  (cast-vote! [this] [this cmnt] [this member cmnt]))
;
;
;(defrecord CommentVoteDist
;  [p-agree p-disagree]
;  Voteable
;  (cast-vote! [_]
;    (let [r (rand)]
;      (cond
;        (> r p-agree) -1
;        (> r (+ p-agree p-disagree)) 1
;        :else 0))))
;
;
;(defn comment-vote-dist!
;  "A somewhat bimodal random vote distribution generator. Could be more principaled about this, but I think
;  it's fine for starters."
;  ([]
;   (let [p1 (rand)
;         p2 (rand (- 1 p1))
;         p1-for-aggree (= (rand-int 2) 0)
;         p-agree (if p1-for-aggree p1 p2)
;         p-disagree (if p1-for-aggree p2 p1)]
;     (CommentVoteDist. p-agree p-disagree)))
;  ([p-agree]
;   (let [p-disagree (rand (- 1 p-agree))]
;     (CommentVoteDist. p-agree p-disagree)))
;  ([p-agree p-disagree]
;   (assert (<= (+ p-agree p-disagree) 1))
;   (CommentVoteDist. p-agree p-disagree)))
;
;
;(defrecord Group
;  [comment-dists]
;  Voteable
;  (cast-vote! [_ cmnt]
;    (cast-vote! (get comment-dists cmnt))))
;
;
;(defn new-group []
;  (Group. []))
;
;
;(defn grp-add-cmnt
;  [grp & {:keys [dist]}]
;  (update-in grp [:comment-dists] conj (or dist (comment-vote-dist!))))
;
;
;(defn random-grp-i
;  [grp-dists]
;  (first
;    (simple/sample (range (count grp-dists))
;                   :weight grp-dists)))
;
;
;(defn add-member
;  [conv & [grp-i]]
;  (let [member (count (:members conv))]
;    (-> conv
;        (update-in [:members] conj (or grp-i (random-grp-i (:grp-dists conv))))
;        (update-in [:unvoted] into (for [c (range (:comments conv))] [member c])))))
;
;
;(defn conv-add-cmnt
;  [conv]
;  (let [cmnt (:comments conv)]
;    (-> conv
;        (update-in [:groups] (partial mapv grp-add-cmnt))
;        (update-in [:unvoted] into (for [m (range (count (:members conv)))] [m cmnt]))
;        (update-in [:comments] inc))))
;
;
;(defn fn-exp
;  [f n]
;  (apply comp (repeat n f)))
;
;
;(defn add-members
;  [conv n]
;  ((fn-exp add-member n) conv))
;
;
;(defn add-cmnts
;  [conv n]
;  ((fn-exp conv-add-cmnt n) conv))
;
;
;(defn sim-conv
;  [& {:keys [zid n-grps grp-dists n-ptpts n-cmnts] :or {n-grps 3 n-ptpts 0 n-comnts 0}}]
;  (-> {:zid (or zid (rand-int 1000))
;       :groups (repeat n-grps (new-group))
;       :unvoted []
;       :members [] ; actually a map of member indices to group indices
;       :comments 0
;       :grp-dists (or grp-dists (repeat n-grps (/ 1 n-grps)))}
;      (add-members n-ptpts)
;      (add-cmnts n-cmnts)))
;
;
;(defn conv-votes
;  [conv & [n]]
;  (let [n (or n 1)]
;    (let [zid (:zid conv)
;          picks (reservoir/sample (:unvoted conv) n)
;          new-conv (update-in conv [:unvoted] (partial remove (set picks)))
;          ; Handle the situation where we want more votes than there are :unvoted (ptpt, cmnt) pairs by having
;          ; revotes
;          picks (if (= (count picks) n)
;                  picks
;                  (concat picks (for [_ (range (- n (count picks)))]
;                                  [(rand-int (count (:members conv)))
;                                   (rand-int (:comments conv))])))
;          votes (map
;                  (fn [[m c]]
;                    (let [grp-i (get-in conv [:members m])
;                          grp ((:groups conv) grp-i)]
;                      {:zid zid :pid m :tid c :vote (cast-vote! grp c)}))
;                  picks)]
;      ; Return the new conversation state so it can be looped on
;      [new-conv votes])))
;
;
;(defprotocol Pollable
;  (poll! [this state last-vote-timestamp]))
;
;
;(defn unzip
;  [xys]
;  (reduce
;    (fn [[xs ys] xy]
;      [(conj xs (first xy)) (conj ys (second xy))])
;    [[] []]
;    xys))
;
;
;(defn rand-ms
;  [max]
;  (+ (* (rand-int (int (/ max 1000)))
;        1000)
;     (rand-int 1000)))
;
;
;
;(defn add-timestamps
;  [[conv votes] last-vote-timestamp]
;  (let [old-last-ts (or last-vote-timestamp 0)
;        now (System/currentTimeMillis)
;        ts-diff (- now old-last-ts)]
;    [conv
;     (map #(assoc % :created (+ (rand-ms ts-diff) old-last-ts)) votes)]))
;
;
;(defn new-poller
;  "Takes a collection of conversation simulators, and a set of growth functions, each of which takes an argument of
;  the conversation sims, and uses infomation there to decide how to modify the conversation and how to poll"
;  [& {:keys [ptpt-growth-fn
;             cmnt-growth-fn
;             poll-count-fn]}]
;  (reify
;    Pollable
;    (poll! [this conv last-vote-timestamp]
;      (let [[new-ptpts new-cmnts n-votes] (map #(% conv) [ptpt-growth-fn cmnt-growth-fn poll-count-fn])]
;        (-> conv
;            ((fn-exp add-member new-ptpts))
;            ((fn-exp conv-add-cmnt new-cmnts))
;            (conv-votes n-votes)
;            ; Adds :created timestamps
;            (add-timestamps last-vote-timestamp))))))
;
;
;(def simple-poller
;  (new-poller
;    :ptpt-growth-fn (fn [conv] 10)
;    :cmnt-growth-fn (fn [conv] 1)
;    :poll-count-fn (fn [conv]
;                     (* (inc (count (:members conv))) 2))))
;
;
;(defn comp-poller
;  [& pollers]
;  (reify
;    Pollable
;    (poll! [this convs last-vote-timestamp]
;      (let [[new-convs vote-batches]
;            (unzip
;              (map #(poll! %1 %2 last-vote-timestamp) pollers convs))]
;        [new-convs
;         (->> vote-batches
;              (apply concat)
;              (sort-by :created))]))))
;
;
;(defn int-opt [& args]
;  (conj (into [] args)
;    :parse-fn #(Integer/parseInt %)))
;
;
;(def cli-options
;  [(int-opt "-i" "--poll-interval INTERVAL" "Milliseconds between randomly generated polls" :default 1000)
;   (int-opt "-z" "--n-convs NUMBER" "Number of conversations to simulate" :default 3)
;   (int-opt "-p" "--person-count-start COUNT" :default 4)
;   (int-opt "-P" "--person-count-growth COUNT" :default 3)
;   (int-opt "-c" "--comment-count-start COUNT" :default 3)
;   (int-opt "-C" "--comment-count-growth COUNT" :default 1)
;   ["-h" "--help"]])
;
;
;(defn usage [options-summary]
;  (->> ["Polismath simulations"
;        "Usage: lein run -m polismath.simulation [options]"
;        ""
;        "Options:"
;        options-summary]
;   (string/join \newline)))
;
;
;;; Just commenting out the redis/carmine specific stuff
;
;;; See `wcar` docstring for opts
;;(def server1-conn {:pool {}
;                   ;:spec {}})
;;(defmacro wcar* [& body] `(car/wcar server1-conn ~@body))
;;(def wcar-worker* (partial car-mq/worker server1-conn))
;
;;(defn simulate!
;  ;[{:keys [n-convs poll-interval]}]
;  ;(let [pollers (repeat n-convs simple-poller)
;        ;poller (apply comp-poller pollers)]
;    ;(loop [convs (for [i (range n-convs)]
;                   ;(sim-conv :n-ptpts 4 :n-cmnts 5 :zid i))
;           ;last-vote-timestamp 0
;           ;polls 0]
;      ;(Thread/sleep poll-interval)
;      ;(let [[new-convs votes] (poll! poller convs last-vote-timestamp)
;            ;new-last-vote-timestamp (apply max (map :created votes))]
;        ;(println "Simulating" (count votes))
;        ;(wcar* (car-mq/enqueue "simvotes" (vec votes)))
;        ;(recur new-convs new-last-vote-timestamp (inc polls))))))
;
;;(comment
;  ;(simulate! {:n-convs 3 :poll-interval 3})
;  ;)
;
;
;;;; XXX Move to a system
;;(defn -main [& args]
;  ;(println "Starting simulations")
;  ;(let [{:keys [options arguments errors summary]} (parse-opts args cli-options)]
;    ;(cond
;      ;(:help options)   (exit 0 (usage summary))
;      ;(:errors options) (exit 1 (str "Found the following errors:" \newline (:errors options)))
;      ;:else             (simulate! options))))
;

