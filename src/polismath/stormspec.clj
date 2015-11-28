(ns polismath.stormspec
  (:import [backtype.storm StormSubmitter LocalCluster])
  (:require [polismath.conv-man :as cm]
            [polismath.components.postgres :as postgres]
            [polismath.components.env :as env]
            [polismath.math.named-matrix :as nm]
            [polismath.utils :as utils]
            [polismath.math.conversation :as conv]
            ;[polismath.simulation :as sim]
            [clojure.core.matrix :as matrix]
            [clojure.string :as string]
            [clojure.tools.logging :as log]
            [clojure.core.async :as async :refer [go <! >! <!! >!! alts!! alts! chan dropping-buffer put! take!]]
            [com.stuartsierra.component :as component]
            [backtype.storm [clojure :as storm] [config :as storm-config]]
            [plumbing.core :as pc])
  ;; I don't think we need this anymore on newer Clojures, so should remove XXX
  (:gen-class))


;; XXX Maybe loading the current implementation can be a system boot step?
; XXX - storm hack. Solves issue where one process or thread has started loading vectorz, but the other
; doesn't know to wait (at least this is what seems to be the case)
;(matrix/set-current-implementation :vectorz)
;(matrix/matrix [[1 2 3] [4 5 6]])


(storm/defspout poll-spout ["type" "zid" "batch"]
  {:params [storm-cluster type poll-fn timestamp-key poll-interval] :prepare true}
  [conf context collector]
  (let [last-timestamp (atom 0)
        postgres (-> storm-cluster :postgres)]
    (storm/spout
      (nextTuple []
        (log/info "Polling" type ">" @last-timestamp)
        (let [poll-function (get {:poll postgres/poll :mod-poll postgres/mod-poll} poll-fn)
              results (poll-function postgres @last-timestamp)
              grouped-batches (group-by :zid results)]
          ; For each chunk of votes, for each conversation, send to the appropriate spout
          (doseq [[zid batch] grouped-batches]
            (storm/emit-spout! collector [type zid batch]))
          ; Update timestamp if needed
          (swap! last-timestamp
                 (fn [last-ts] (apply max 0 last-ts (map timestamp-key results)))))
        (Thread/sleep poll-interval))
      (ack [id]))))

;; XXX Should build a recompute trigger spout, which just sends a recompute message type with nil batch payload

(storm/defbolt conv-update-bolt []
  {:params [storm-cluster] :prepare true}
  [conf context collector]
  (let [conv-man (:conversation-manager storm-cluster)
        config (:config storm-cluster)]
    (storm/bolt
      (execute [tuple]
        (let [[message-type zid batch] (.getValues tuple)]
          ;; XXX Need to think more about recompute...
          (cm/queue-message-batch! conv-man message-type zid batch (-> config :recompute)))
        (storm/ack! collector tuple)))))

(defn make-topology
  [{:keys [config] :as storm-cluster}]
  (let [spouts {"vote-spout" (storm/spout-spec (poll-spout :votes :poll :created (:vote-polling-interval config)))
                "mod-spout"  (storm/spout-spec (poll-spout :moderation :mod-poll :modified (:mod-polling-interval config)))}
        bolt-inputs (into {} (for [s (keys spouts)] [s ["zid"]]))]
    (assoc storm-cluster
           :topology
           (storm/topology
             spouts
             {"conv-update" (storm/bolt-spec bolt-inputs (conv-update-bolt (:recompute config)))}))))

(defn run-local! [{:keys [sim recompute]}]
  (let [cluster (LocalCluster.)]
    (.submitTopology cluster
                     "online-pca"
                     {storm-config/TOPOLOGY-DEBUG false}
                     (make-topology sim recompute))))


(defn submit-topology!
  [storm-cluster]
  (let [{:keys [execution cluster-name workers]} (-> storm-cluster :config :storm)
        submitter (case execution
                    :local (LocalCluster.)
                    :distributed (StormSubmitter.))]
    (.submitTopology submitter
                     cluster-name
                     {storm-config/TOPOLOGY-DEBUG false
                      storm-config/TOPOLOGY-WORKERS workers}
                     (make-topology storm-cluster)))
  storm-cluster)

(defn stop-cluster!
  [storm-cluster]
  (let [topology (:topology storm-cluster)
        cluster-name (-> storm-cluster :config :storm :cluster-name)]
    (.killTopology topology cluster-name)
    (.shutdown topology)))


(defrecord StormCluster [config conversation-manager topology]
  component/Lifecycle
  (start [component]
    (-> component
        make-topology
        submit-topology!))
  (stop [component]
    (stop-cluster! component)
    (assoc component :topology nil)))


(defn create-storm-cluster []
  (map->StormCluster {}))


