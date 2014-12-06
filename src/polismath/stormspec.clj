(ns polismath.stormspec
  (:import [backtype.storm StormSubmitter LocalCluster])
  (:require [polismath.simulation :as sim]
            [polismath.conv-man :as cm]
            [polismath.db :as db]
            [clojure.core.matrix :as ccm]
            [plumbing.core :as pc]
            [polismath.env :as env]
            [clojure.string :as string]
            [clojure.newtools.cli :refer [parse-opts]]
            [clojure.tools.logging :as log])
  (:use [backtype.storm clojure config]
        polismath.named-matrix
        polismath.utils
        polismath.conversation)
  (:gen-class))


; XXX - storm hack. Solves issue where one process or thread has started loading vectorz, but the other
; doesn't know to wait (at least this is what seems to be the case)
(ccm/set-current-implementation :vectorz)
(ccm/matrix [[1 2 3] [4 5 6]])

(let [at-a-time 100
      interval  1000
      reaction-gen
        (atom
          (sim/make-vote-gen 
            {:n-convs 3
             :vote-rate interval
             :person-count-start 4
             :person-count-growth 5
             :comment-count-start 3
             :comment-count-growth 3}))]
  (defn sim-poll! [& {:keys [last-timestamp] :as opts}]
    (let [results (take at-a-time @reaction-gen)]
      (swap! reaction-gen (partial drop at-a-time))
      (map (pc/fn-> (assoc :created (- last-timestamp (rand 500)))) results)))

  (defn poll [last-timestamp]
    (let [db-results (db/poll last-timestamp)
          last-timestamp (reduce max last-timestamp (map :created db-results))
          sim-results (sim-poll! :last-timestamp last-timestamp)]
      (concat db-results sim-results))))


(defspout sim-reaction-spout ["zid" "last-timestamp" "reactions"] {:prepare true}
  [conf context collector]
  (let [at-a-time 100
        interval  1000
        reaction-gen
          (atom
            (sim/make-vote-gen 
              {:n-convs 3
               :vote-rate interval
               :person-count-start 4
               :person-count-growth 5
               :comment-count-start 3
               :comment-count-growth 3}))]
    (spout
      (nextTuple []
        (log/info "Polling simutated reaction spout")
        (let [rxn-batch (take at-a-time @reaction-gen)
              split-rxns (group-by :zid rxn-batch)
              last-timestamp (System/currentTimeMillis)]
          (Thread/sleep interval)
          (swap! reaction-gen (partial drop at-a-time))
          (doseq [[zid rxns] split-rxns]
            (emit-spout! collector [zid last-timestamp rxns]))))
      (ack [id]))))


(defspout reaction-spout ["zid" "last-timestamp" "reactions"] {:prepare true}
  [conf context collector]
  (let [poll-interval   1000
        last-timestamp  (atom 0)]
    (spout
      (nextTuple []
        (log/info "Polling :created >" @last-timestamp)
        (let [new-votes (poll @last-timestamp)
              grouped-votes (group-by :zid new-votes)]
          ; For each chunk of votes, for each conversation, send to the appropriate spout
          (doseq [[zid rxns] grouped-votes]
            (emit-spout! collector [zid @last-timestamp rxns]))
          ; Update timestamp if needed
          (swap! last-timestamp
                 (fn [last-ts] (apply max 0 last-ts (map :created new-votes)))))
        (Thread/sleep poll-interval))
      (ack [id]))))


(defbolt conv-update-bolt [] {:prepare true}
  [conf context collector]
  (let [conv-agency (atom {})] ; collection of conv-actors
    (bolt
      (execute [tuple]
        (let [[zid last-timestamp rxns] (.getValues tuple)
              ; First construct a new conversation builder. Then either find a conversation, or call that
              ; builder in conv-agency
              conv-actor (cm/get-or-set! conv-agency zid
                           (fn []
                             (let [ca (cm/new-conv-actor (partial cm/load-or-init zid))]
                               (add-watch
                                 (:conv ca)
                                 :size-watcher
                                 (fn [k r o n]
                                   (when ((set (range 4)) (:zid n))
                                     (log/info "Size of conversation" (:zid n) "is" (:n n) (:n-cmts n)))))
                               ca)))]
          (cm/send-votes conv-actor {:last-timestamp last-timestamp :reactions rxns}))
        (ack! collector tuple)))))


(defn mk-topology [sim?]
  (topology
    ; Spouts:
    {"1" (spout-spec
           (if sim? sim-reaction-spout reaction-spout))}
    ; Bolts:
    {"2" (bolt-spec
           {"1"  ["zid"]}
           conv-update-bolt)}))


(defn run-local! [{sim :sim}]
  (let [cluster (LocalCluster.)]
    (.submitTopology cluster
                     "online-pca"
                     {TOPOLOGY-DEBUG false}
                     (mk-topology sim))))


(defn submit-topology! [name {sim :sim}]
  (StormSubmitter/submitTopology name
    {TOPOLOGY-DEBUG false
     TOPOLOGY-WORKERS 3}
    (mk-topology sim)))


(def cli-options
  "Has the same options as simulation if simulations are run"
  (into
    [["-n" "--name" "Cluster name; triggers submission to cluster" :default nil]
     ["-s" "--sim"]]
    sim/cli-options))


(defn usage [options-summary]
  (->> ["Polismath stormspec"
        "Usage: lein run -m polismath.stormspec [options]"
        ""
        "Options:"
        options-summary]
   (string/join \newline)))


(defn -main [& args]
  (let [{:keys [options arguments errors summary]} (parse-opts args cli-options)]
    (log/info "Submitting storm topology")
    (cond
      (:help options)   (exit 0 (usage summary))
      (:errors options) (exit 1 (str "Found the following errors:" \newline (:errors options)))
      :else 
        (if-let [name (:name options)]
          (submit-topology! name options)
          (run-local! options)))))


