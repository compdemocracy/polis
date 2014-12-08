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
            [clojure.tools.logging :as log]
            [clojure.core.async
             :as as
             :refer [go <! >! <!! >!! alts!! alts! chan dropping-buffer
                     put! take!]])
  (:use [backtype.storm clojure config]
        polismath.named-matrix
        polismath.utils
        polismath.conversation)
  (:gen-class))


; XXX - storm hack. Solves issue where one process or thread has started loading vectorz, but the other
; doesn't know to wait (at least this is what seems to be the case)
(ccm/set-current-implementation :vectorz)
(ccm/matrix [[1 2 3] [4 5 6]])



(if (env/env :poll-redis)
  (let [sim-vote-chan (chan 10e5)]
    (log/warn "XXX: Going to be polling redis for simulated votes")
    ; Function that starts a service which polls redis and throws it onto a queue
    (defn start-sim-poller!
      []
      (sim/wcar-worker*
        "simvotes"
        {:handler (fn [{:keys [message attempt]}]
                    (log/debug "Have some sim votes")
                    (let [[_ vote-batch] message]
                      (>!! sim-vote-chan vote-batch))
                    {:status :success})}))
    ; Construct a poller that also check the channel for simulated messages and passes them through
    (defn poll
      "Do stuff with the fake comments and sim comments"
      [last-timestamp]
      (let [db-results (db/poll last-timestamp)
            last-timestamp (reduce max last-timestamp (map :created db-results))
            sim-batches (cm/take-all!! sim-vote-chan)
            combined-results (concat db-results sim-batches)]
        (concat db-results sim-batches))))
  ; Else, defer to regular poller
  (def poll db/poll))


(defspout reaction-spout ["zid" "last-timestamp" "reactions"] {:prepare true}
  [conf context collector]
  (let [poll-interval   1000
        last-timestamp  (atom 0)]
    (when (env/env :poll-redis)
      (log/info "Starting sim poller!")
      (start-sim-poller!))
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


(defbolt conv-update-bolt [] {:params [recompute] :prepare true}
  [conf context collector]
  (let [conv-agency (atom {})] ; collection of conv-actors
    (bolt
      (execute [tuple]
        (let [[zid last-timestamp rxns] (.getValues tuple)
              ; First construct a new conversation builder. Then either find a conversation, or call that
              ; builder in conv-agency
              conv-actor (cm/get-or-set! conv-agency zid
                           (fn []
                             (let [ca (cm/new-conv-actor (partial cm/load-or-init zid :recompute recompute))]
                               (add-watch
                                 (:conv ca)
                                 :size-watcher
                                 (fn [k r o n]
                                   (when ((set (range 4)) (:zid n))
                                     (log/info "Size of conversation" (:zid n) "is" (:n n) (:n-cmts n)))))
                               ca)))]
          (cm/send-votes conv-actor {:last-timestamp last-timestamp :reactions rxns}))
        (ack! collector tuple)))))


(defn mk-topology [sim recompute]
  (topology
    ; Spouts:
    {"1" (spout-spec
           ;(if sim sim-reaction-spout reaction-spout))}
           reaction-spout)}
    ; Bolts:
    {"2" (bolt-spec
           {"1"  ["zid"]}
           (conv-update-bolt recompute))}))


(defn run-local! [{:keys [sim recompute]}]
  (let [cluster (LocalCluster.)]
    (.submitTopology cluster
                     "online-pca"
                     {TOPOLOGY-DEBUG false}
                     (mk-topology sim recompute))))


(defn submit-topology! [name {:keys [sim recompute]}]
  (StormSubmitter/submitTopology name
    {TOPOLOGY-DEBUG false
     TOPOLOGY-WORKERS 3}
    (mk-topology sim recompute)))


(def cli-options
  "Has the same options as simulation if simulations are run"
  (into
    [["-n" "--name" "Cluster name; triggers submission to cluster" :default nil]
     ["-s" "--sim"]
     ["-r" "--recompute"]]
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


