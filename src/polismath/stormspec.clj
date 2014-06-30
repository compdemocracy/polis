(ns polismath.stormspec
  (:import [backtype.storm StormSubmitter LocalCluster])
  (:require [polismath.simulation :as sim]
            [clojure.string :as string]
            [clojure.newtools.cli :refer [parse-opts]])
  (:use [backtype.storm clojure config]
        polismath.named-matrix
        polismath.utils
        polismath.conversation)
  (:gen-class))


(defspout reaction-spout ["conv-id" "reaction"] {:prepare true}
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
              split-rxns (group-by :zid rxn-batch)]
          (Thread/sleep interval)
          (println "RUNNING SPOUT")
          (swap! reaction-gen (partial drop at-a-time))
          (doseq [[conv-id rxns] split-rxns]
            (emit-spout! collector [conv-id rxns]))))
      (ack [id]))))


(defbolt conv-update-bolt ["conv"] {:prepare true}
  [conf context collector]
  (let [conv (agent {:rating-mat (named-matrix)})]
    (bolt (execute [tuple]
      (let [[conv-id rxns] (.getValues tuple)]
        (send conv conv-update rxns)
        (emit-bolt! collector
                    [@conv]
                    :anchor tuple)
        (ack! collector tuple))))))


(defn mk-topology []
  (topology
    ; Spouts:
    {"1" (spout-spec reaction-spout)}
    ; Bolts:
    {"2" (bolt-spec
           {"1"  ["conv-id"]}
           conv-update-bolt)}))


(defn run-local! []
  (let [cluster (LocalCluster.)]
    (.submitTopology cluster "online-pca" {TOPOLOGY-DEBUG true} (mk-topology))))


(defn submit-topology! [name]
  (StormSubmitter/submitTopology
    name
    {TOPOLOGY-DEBUG true
     TOPOLOGY-WORKERS 3}
    (mk-topology)))


(def cli-options
  "Has the same options as simulation if simulations are run"
  (into
    [["-n" "--name" "Cluster name; triggers submission to cluster" :default nil]]
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
          (submit-topology! name)
          (run-local!)))))


