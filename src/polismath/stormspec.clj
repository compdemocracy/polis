(ns polismath.stormspec
  (:import [backtype.storm StormSubmitter LocalCluster])
  (:require [polismath.simulation :as sim]
            [polismath.poller :as poll]
            [polismath.queued-agent :as qa]
            [environ.core :as env]
            [clojure.string :as string]
            [clojure.newtools.cli :refer [parse-opts]])
  (:use [backtype.storm clojure config]
        polismath.named-matrix
        polismath.utils
        polismath.conversation)
  (:gen-class))


(defspout sim-reaction-spout ["zid" "last-timestamp" "reaction"] {:prepare true}
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
          (println "RUNNING SPOUT")
          (swap! reaction-gen (partial drop at-a-time))
          (doseq [[zid rxns] split-rxns]
            (emit-spout! collector [zid last-timestamp rxns]))))
      (ack [id]))))


(defspout reaction-spout ["zid" "last-timestamp" "reaction"] {:prepare true}
  [conf context collector]
  (let [poll-interval   1000
        pg-spec         (poll/heroku-db-spec (env/env :database-url))
        mg-db           (poll/mongo-connect! (env/env :mongo-url))
        last-timestamp  (atom 0)]
    (spout
      (nextTuple []
        (Thread/sleep poll-interval)
        (println "poll >" @last-timestamp)
        (let [new-votes (poll/poll pg-spec @last-timestamp)
              grouped-votes (group-by :zid)]
          (doseq [[zid rxns] grouped-votes]
            (emit-spout! collector [zid @last-timestamp rxns]))
          (swap! last-timestamp (fn [_] (:created (last new-votes))))))
      (ack [id]))))


(defn get-or-set!
  "Either gets the key state of a collection atom, or sets it to a val"
  [coll-atom key & [init-fn]]
  (or (get @coll-atom key)
      (do
        (swap! coll-atom assoc key (init-fn))
        (get-or-set! coll-atom key))))


(defn update-fn-builder [zid write?]
  (fn [conv values]
    (let [votes (flatten values)
          new-conv (conv-update conv votes)
          last-timestamp "4433455656"]
      ; Format and upload results
      (when write?
        (->> (poll/format-conv-for-mongo conv zid last-timestamp)
          (poll/mongo-upsert-results "polismath_bidToPid_april9" zid last-timestamp)))
      new-conv)))


(defn new-conv-agent-builder [update-fn]
  (fn []
    (qa/queued-agent
      :update-fn update-fn
      :init-fn new-conv)))


(defbolt conv-update-bolt [] {:prepare true :params [write?]}
  [conf context collector]
  (let [conv-agency (atom {})]
    (bolt
      (execute [tuple]
        (let [[zid last-timestamp rxns] (.getValues tuple)
              conv-agent (->> (update-fn-builder zid write?)
                              (new-conv-agent-builder)
                              (get-or-set! conv-agency zid))]
          (qa/enqueue conv-agent rxns)
          ; This just triggers the :update-watcher in case new votes are pending and nothing is running
          (qa/ping conv-agent))
        (ack! collector tuple)))))


(defn mk-topology [sim? write?]
  (topology
    ; Spouts:
    {"1" (spout-spec
           (if sim? sim-reaction-spout reaction-spout))}
    ; Bolts:
    {"2" (bolt-spec
           {"1"  ["zid"]}
           (conv-update-bolt write?))}))


(defn run-local! [{sim :sim write :write}]
  (let [cluster (LocalCluster.)]
    (.submitTopology cluster
                     "online-pca"
                     {TOPOLOGY-DEBUG true}
                     (mk-topology sim write))))


(defn submit-topology! [name {sim :sim write :write}]
  (StormSubmitter/submitTopology name
    {TOPOLOGY-DEBUG true
     TOPOLOGY-WORKERS 3}
    (mk-topology sim write)))


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
    (cond
      (:help options)   (exit 0 (usage summary))
      (:errors options) (exit 1 (str "Found the following errors:" \newline (:errors options)))
      :else 
        (if-let [name (:name options)]
          (submit-topology! name options)
          (run-local! options)))))


