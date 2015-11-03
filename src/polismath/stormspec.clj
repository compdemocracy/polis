(ns polismath.stormspec
  (:import [backtype.storm StormSubmitter LocalCluster])
  (:require [polismath.conv-man :as cm]
            [polismath.components.db :as db]
            [polismath.components.env :as env]
            [polismath.math.named-matrix :as nm]
            [polismath.utils :as utils]
            [polismath.math.conversation :as conv]
            ;[polismath.simulation :as sim]
            [clojure.core.matrix :as matrix]
            [clojure.string :as string]
            [clojure.newtools.cli :refer [parse-opts]]
            [clojure.tools.logging :as log]
            [clojure.core.async :as async :refer [go <! >! <!! >!! alts!! alts! chan dropping-buffer put! take!]]
            [backtype.storm [clojure :as storm] [config :as storm-config]]
            [plumbing.core :as pc])
  ;; I don't think we need this anymore on newer Clojures, so should remove XXX
  (:gen-class))


;; XXX Maybe loading the current implementation can be a system boot step?
; XXX - storm hack. Solves issue where one process or thread has started loading vectorz, but the other
; doesn't know to wait (at least this is what seems to be the case)
(matrix/set-current-implementation :vectorz)
(matrix/matrix [[1 2 3] [4 5 6]])


;(let [sim-vote-chan (chan 10e5)]
  ;(log/warn "Going to be polling redis for simulated votes")
  ;; Function that starts a service which polls redis and throws it onto a queue
  ;(defn start-sim-poller!
    ;[]
    ;(sim/wcar-worker*
      ;"simvotes"
      ;{:handler (fn [{:keys [message attempt] :as handler-args}]
                  ;(if message
                    ;(>!! sim-vote-chan message)
                    ;(log/warn "Nil message to carmine?" handler-args))
                  ;{:status :success})}))
  ;; Construct a poller that also check the channel for simulated messages and passes them through
  ;(defn sim-poll
    ;"Do stuff with the fake comments and sim comments"
    ;[last-vote-timestamp]
    ;(cm/take-all!! sim-vote-chan)))


(storm/defspout poll-spout ["type" "zid" "batch"] {:prepare true :params [type poll-fn timestamp-key poll-interval]}
  [conf context collector]
  (let [last-timestamp (atom 0)]
    ;(if (= poll-fn :sim-poll)
      ;(log/info "Starting sim poller!")
      ;(start-sim-poller!))
    (storm/spout
      (nextTuple []
        (log/info "Polling" type ">" @last-timestamp)
        (let [results (({:poll db/poll
                         ;:sim-poll sim-poll
                         :mod-poll db/mod-poll} poll-fn)
                       @last-timestamp)
              grouped-batches (group-by :zid results)]
          ; For each chunk of votes, for each conversation, send to the appropriate spout
          (doseq [[zid batch] grouped-batches]
            (storm/emit-spout! collector [type zid batch]))
          ; Update timestamp if needed
          (swap! last-timestamp
                 (fn [last-ts] (apply max 0 last-ts (map timestamp-key results)))))
        (Thread/sleep poll-interval))
      (ack [id]))))


(storm/defbolt conv-update-bolt [] {:params [recompute] :prepare true}
  [conf context collector]
  (let [conv-agency (atom {})] ; collection of conv-actors
    (storm/bolt
      (execute [tuple]
        (let [[type zid batch] (.getValues tuple)
              ; First construct a new conversation builder. Then either find a conversation, or call that
              ; builder in conv-agency
              conv-actor (cm/get-or-set! conv-agency zid #(cm/new-conv-actor (partial cm/load-or-init zid :recompute recompute)))]
          (cm/snd conv-actor [type batch]))
        (storm/ack! collector tuple)))))


(defn mk-topology [sim recompute]
  (let [spouts {"vote-spout" (storm/spout-spec (poll-spout :votes :poll :created 1000))
                "mod-spout"  (storm/spout-spec (poll-spout :moderation :mod-poll :modified 5000))}
        ;; No-op for now
        ;spouts (if sim
                 ;(do
                   ;(log/info "Simulation disabled for the moment")
                   ;(assoc spouts "sim-vote-spout" (storm/spout-spec (poll-spout "votes" :sim-poll :created 1000)))
                   ;)
                 ;spouts)
        bolt-inputs (into {} (for [s (keys spouts)] [s ["zid"]]))]
  (storm/topology
    spouts
    {"conv-update" (storm/bolt-spec bolt-inputs (conv-update-bolt recompute))})))


(defn run-local! [{:keys [sim recompute]}]
  (let [cluster (LocalCluster.)]
    (.submitTopology cluster
                     "online-pca"
                     {storm-config/TOPOLOGY-DEBUG false}
                     (mk-topology sim recompute))))


(defn submit-topology! [name {:keys [sim recompute]}]
  (StormSubmitter/submitTopology name
    {storm-config/TOPOLOGY-DEBUG false
     storm-config/TOPOLOGY-WORKERS 3}
    (mk-topology sim recompute)))


(def cli-options
  "Has the same options as simulation if simulations are run"
  (into
    [["-n" "--name" "Cluster name; triggers submission to cluster" :default nil]
     ;["-s" "--sim" "DEPRECATED! No longer works"]
     ["-r" "--recompute"]]
    ; XXX
    ;sim/cli-options)
    [])
  )


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
      (:help options)   (utils/exit 0 (usage summary))
      (:errors options) (utils/exit 1 (str "Found the following errors:" \newline (:errors options)))
      :else 
        (if-let [name (:name options)]
          (submit-topology! name options)
          (run-local! options)))))


