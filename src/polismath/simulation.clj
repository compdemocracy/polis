(ns polismath.simulation
  (:require [clojure.newtools.cli :refer [parse-opts]]
            [clojure.string :as string]
            [taoensso.timbre.profiling :as profiling
              :refer (pspy pspy* profile defnp p p*)])
  (:use polismath.utils
        alex-and-georges.debug-repl
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
  (let [big-ptpts    20000
        big-comments 100
        a (conv-update {:rating-mat (named-matrix)} (random-votes 100 10))
        a (time2 "CONVUP med" (conv-update a (random-votes 500 10)))
        a (time2 "CONVUP big" (conv-update a (random-votes big-ptpts big-comments)))]
    (profile :info :clusters
      (time2 "CONVUP big-part" (conv-update a (random-votes big-ptpts (+ big-comments 2)) :large-cutoff 10000)))))


(defn replay-conv-update [filename]
  (let [data (load-conv-update filename)
        {:keys [conv votes opts]} data
        {:keys [rating-mat base-clusters pca]} conv]
    (println "Loaded conv:" filename)
    (println "Dimensions:" (count (rownames rating-mat)) "x" (count (colnames rating-mat)))
    (conv-update conv votes)))


