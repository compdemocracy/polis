;; Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.poller
  (:require [clojure.core.async :as async :refer [go go-loop >! <! >!! <!!]]
            [com.stuartsierra.component :as component]
            [polismath.conv-man :as conv-man]
            [environ.core :as env]
            [polismath.components.postgres :as postgres]
            [taoensso.timbre :as log]))


(defn poll
  [{:as poller :keys [conversation-manager postgres kill-chan]} message-type]
  (let [start-polling-from
        ;; TODO; Replace this catch with config parsing options
        (try (java.lang.Long/parseLong (:initial-polling-timestamp env/env))
             (catch Exception e (log/warn "INITIAL_POLLING_TIMESTAMP not set; setting to 0") 0))
        polling-interval (or (-> poller :config :storm :spouts message-type :polling-interval) 1000)
        [poll-function timestamp-key]
        (get {:votes [postgres/poll :created]
              :moderation [postgres/mod-poll :modified]}
             message-type)]
    (go-loop [last-timestamp start-polling-from]
      ;(when-not (async/poll! (:kill-chan poller)) ;; TODO When we upgrade clojure & clojure.core.async, should do this
      (when-not (first (async/alts! [kill-chan (async/timeout 0)] :priority true))
        (log/info "Polling" message-type ">" last-timestamp)
        (let [results (poll-function postgres last-timestamp)
              grouped-batches (group-by :zid results)
              last-timestamp (apply max 0 last-timestamp (map timestamp-key results))]
          ; For each chunk of votes, for each conversation, send to the appropriate spout
          (doseq [[zid batch] grouped-batches]
            ;; TODO; Erm... need to sort out how we're using blocking vs non-blocking ops for threadability
            (conv-man/queue-message-batch! conversation-manager message-type zid batch))
          ; Update timestamp
          (<! (async/timeout polling-interval))
          (recur last-timestamp))))))



(defrecord Poller [message-type config postgres conversation-manager kill-chan]
  component/Lifecycle
  (start [component]
    (log/info ">> Starting" message-type "poller component")
    (let [kill-chan (async/chan)
          component (assoc component :kill-chan kill-chan)]
      (poll component message-type)
      component))
  (stop [component]
    (log/info "<< Stopping" message-type "poller component")
    (go (>! kill-chan :kill))
    component))

(defn create-poller
  ([message-type]
   (create-poller message-type {}))
  ([message-type options]
   (map->Poller (merge options {:message-type message-type}))))


