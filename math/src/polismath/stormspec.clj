;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.stormspec)
  ;(:import [backtype.storm StormSubmitter LocalCluster])
  ;(:require [polismath.system :as system]
  ;          [polismath.conv-man :as cm]
  ;          [polismath.components.postgres :as postgres]
  ;          [polismath.components.env :as env]
  ;          [polismath.math.named-matrix :as nm]
  ;          [polismath.utils :as utils]
  ;          [polismath.math.conversation :as conv]
  ;          ;[polismath.simulation :as sim]
  ;          [clojure.core.matrix :as matrix]
  ;          [clojure.string :as string]
  ;          [clojure.tools.logging :as log]
  ;          [clojure.core.async :as async :refer [go <! >! <!! >!! alts!! alts! chan dropping-buffer put! take!]]
  ;          [com.stuartsierra.component :as component]
  ;          [backtype.storm [clojure :as storm] [config :as storm-config]]
  ;          [plumbing.core :as pc])
  ;;; I don't think we need this anymore on newer Clojures, so should remove XXX
  ;(:gen-class))


;; XXX Maybe loading the current implementation can be a system boot step?
; XXX - storm hack. Solves issue where one process or thread has started loading vectorz, but the other
; doesn't know to wait (at least this is what seems to be the case)
;(matrix/set-current-implementation :vectorz)
;(matrix/matrix [[1 2 3] [4 5 6]])


(comment
  (storm/defspout poll-spout ["message-type" "zid" "batch"]
    ;; Should fork timestamp key on message-type as well XXX
    {:params [system-config message-type timestamp-key] :prepare true}
    [conf context collector]
    ;(let [last-timestamp (atom 0)
          ;;; Need config for storm to be set under keys of :vote and :mod, so the spouts are configurable
          ;;; more simply from this; But I guess some of these things should maybe not be constructable this
          ;;; way...
          ;;system (-> system-config system/base-system component/system-map component/start)
          ;system (system/create-and-run-base-system! system-config)
      ;(storm/spout
    (let [system (system/create-and-run-base-system! system-config)
          polling-interval (-> system-config :storm :spouts message-type :polling-interval)
          postgres (-> system :postgres)
          last-timestamp (atom (try (java.lang.Long/parseLong (:initial-polling-timestamp env/env)) (catch Exception e (log/warn "INITIAL_POLLING_TIMESTAMP not set; setting to 0") 0)))]
      ;(if (= poll-fn :sim-poll)
        ;(log/info "Starting sim poller!")
        ;(start-sim-poller!))
      (storm/spout
        (nextTuple []
          (try
            (log/info "Polling" message-type ">" @last-timestamp)
            (let [poll-function (get {:votes postgres/poll :moderation postgres/mod-poll} message-type)
                  results (poll-function postgres @last-timestamp)
                  grouped-batches (group-by :zid results)]
              ; For each chunk of votes, for each conversation, send to the appropriate spout
              (doseq [[zid batch] grouped-batches]
                (storm/emit-spout! collector [message-type zid batch]))
              ; Update timestamp if needed
              (swap! last-timestamp
                     (fn [last-ts] (apply max 0 last-ts (map timestamp-key results)))))
            (catch Exception e
              (log/error "Exception bubbled up in poll-spout!")
              (.printStackTrace e)))
          (Thread/sleep polling-interval))
        (ack [id]))))

  ;; XXX Should build a recompute trigger spout, which just sends a recompute message message-type with nil batch payload

  (storm/defbolt conv-update-bolt []
    {:params [system-config] :prepare true}
    [conf context collector]
    (let [system (system/create-and-run-base-system! system-config)
          conv-man (:conversation-manager system)]
      (storm/bolt
        (execute [tuple]
          (try
            (let [[message-type zid batch] (.getValues tuple)]
              ;; XXX Need to think more about recompute...
              (cm/queue-message-batch! conv-man message-type zid batch))
            (storm/ack! collector tuple)
            (catch Exception e
              (log/error "Exception bubbled up in conv-update-bold!")
              (.printStackTrace e)))))))

  (defn make-topology
    ;; Note here that we're pushing through the full system configuration as config overrides, because we need
    ;; something serializable for the nodes to boot their systems from in the prepare steps
    [{:keys [config] :as storm-cluster}]
    (let [config (into {} config) ;; O/w have a non-serializable object
          spouts {"vote-spout" (storm/spout-spec (poll-spout config :votes :created))
                  "mod-spout"  (storm/spout-spec (poll-spout config :moderation :modified))}
          bolt-inputs (into {} (for [s (keys spouts)] [s ["zid"]]))]
      (assoc storm-cluster
             :topology
             (storm/topology
               spouts
               {"conv-update" (storm/bolt-spec bolt-inputs (conv-update-bolt config))}))))

  (defn submit-topology!
    [storm-cluster]
    (let [{:keys [execution cluster-name workers]} (-> storm-cluster :config :storm)
          cluster-submitter (case execution
                              :local (LocalCluster.)
                              :distributed (StormSubmitter.))]
      (.submitTopology cluster-submitter
                       cluster-name
                       {storm-config/TOPOLOGY-DEBUG false
                        storm-config/TOPOLOGY-WORKERS workers}
                       (:topology storm-cluster))
      (assoc storm-cluster :cluster-submitter cluster-submitter)))

  (defn stop-cluster!
    [{:as storm-cluster :keys [cluster-submitter]}]
    (let [cluster-name (-> storm-cluster :config :storm :cluster-name)]
      ;(.killTopology topology cluster-name)
      (.shutdown cluster-submitter)))


  (defrecord StormCluster [config conversation-manager topology cluster-submitter]
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


  (defn storm-system
    "Creates a base-system and assocs in polismath storm worker related components."
    [config-overrides]
    (merge (system/base-system config-overrides)
           {:storm-cluster (component/using (create-storm-cluster) [:config :conversation-manager])})))


