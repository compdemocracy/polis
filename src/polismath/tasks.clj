;; Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.tasks
  (:require [clojure.core.async :as async :refer [go go-loop >! <! >!! <!!]]
    [com.stuartsierra.component :as component]
    [polismath.conv-man :as conv-man]
    [environ.core :as env]
    [polismath.components.postgres :as postgres]
    [taoensso.timbre :as log]))


;; This is where we listen/poll for and dispatch tasks posted in the :worker_tasks table.
;; The polling code should eventually be unified with the other vote polling code, but for now there are enough subtle differences that we'll bite the bullet on that till later.
;; Additionally, the dispatch code should should remain pretty thin, as this may end up getting translated into flow conditions in a streaming setting.


(defmulti dispatch-task!
  "Given task poller component and a task-record from the database, dispatches on :task_type."
  (fn [_ task-record]
    (:task_type task-record)))

(defmethod dispatch-task! :generate_report_data
  [poller task-record]
  (log/debug "Dispatching generate_report_data")
  (let [zid (->> task-record :task_data :rid (postgres/query-zid-from-rid (:postgres poller)) first :zid)]
    (log/debug "dispatching report generation for zid" zid)
    (conv-man/queue-message-batch! (:conversation-manager poller)
                                   :generate_report_data
                                   zid
                                   (assoc (:task_data task-record)
                                     :task-record task-record))))

(defn poll
  [{:as poller :keys [config postgres kill-chan]}]
  (log/debug "Initializing task poller loop")
  (let [poller-config (-> config :poller)
        start-polling-from (:initial-polling-timestamp poller-config)
        polling-interval (or (-> poller-config :tasks :polling-interval) 1000)]
    (go-loop [last-timestamp start-polling-from]
      (when-not (async/poll! kill-chan) ;; TODO When we upgrade clojure & clojure.core.async, should do this
        (let [results (postgres/poll-tasks postgres last-timestamp)
              last-timestamp (apply max 0 last-timestamp (map :created results))]
          ;; For each chunk of votes, for each conversation, send to the appropriate spout
          (doseq [task-record results]
            ;; TODO; Erm... need to sort out how we're using blocking vs non-blocking ops for threadability
            (dispatch-task! poller task-record))
          ;; Update timestamp
          (<! (async/timeout polling-interval))
          (recur last-timestamp))))))


(defrecord TaskPoller [config postgres conversation-manager kill-chan]
  component/Lifecycle
  (start [component]
    (log/info ">> Starting task poller component")
    (let [kill-chan (async/chan)
          component (assoc component :kill-chan kill-chan)]
      (poll component)
      component))
  (stop [component]
    (log/info "<< Stopping" "poller component")
    (go (>! kill-chan :kill))
    component))

(defn create-task-poller
  ([]
   (create-task-poller {}))
  ([options]
   (map->TaskPoller options)))

