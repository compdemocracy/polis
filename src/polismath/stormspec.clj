(ns polismath.stormspec
  (:import [backtype.storm StormSubmitter LocalCluster])
  (:require [polismath.simulation :as sim]
            [polismath.queued-agent :as qa]
            [polismath.conv-man :as cm]
            [polismath.db :as db]
            [environ.core :as env]
            [clojure.string :as string]
            [clojure.newtools.cli :refer [parse-opts]]
            [clojure.tools.logging :as log])
  (:use [backtype.storm clojure config]
        polismath.named-matrix
        polismath.utils
        polismath.conversation)
  (:gen-class))


(defspout sim-reaction-spout ["zid" "last-timestamp" "reactions"] {:prepare true}
  [conf context collector]
  (let [at-a-time 10
        interval 1000
        reaction-gen
          (atom
            (sim/make-vote-gen 
              {:n-convs 3
               :vote-rate interval
               :person-count-start 4
               :person-count-growth 3
               :comment-count-start 3
               :comment-count-growth 1}))]
    (spout
      (nextTuple []
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
        mg-db           (cm/mongo-connect! (env/env :mongolab-uri))
        last-timestamp  (atom 0)]
    (spout
      (nextTuple []
        (log/info "Polling :created >" @last-timestamp)
        (let [new-votes (db/poll @last-timestamp)
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
  (let [conv-agency (atom {})
        mg-db       (cm/mongo-connect! (env/env :mongolab-uri))]
    (bolt
      (execute [tuple]
        (let [[zid last-timestamp rxns] (.getValues tuple)
              conv-agent (->> cm/update-fn
                              (cm/new-conv-agent-builder)
                              (cm/get-or-set! conv-agency zid))]
          (qa/enqueue conv-agent {:last-timestamp last-timestamp :reactions rxns})
          ; This just triggers the :update-watcher in case new votes are pending and nothing is running
          (qa/ping conv-agent))
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


