;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.tasks
  (:require
    [clojure.core.async :as async :refer [go go-loop >! <! >!! <!!]]
    [com.stuartsierra.component :as component]
    [polismath.conv-man :as conv-man]
    [polismath.darwin.core :as darwin]
    [environ.core :as env]
    [polismath.components.postgres :as postgres]
    [taoensso.timbre :as log]
    [polismath.darwin.export :as export]))


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
  (async/thread
    (let [zid (->> task-record :task_data :rid (postgres/query-zid-from-rid (:postgres poller)) first :zid)]
      (conv-man/queue-message-batch! (:conversation-manager poller)
                                     :generate_report_data
                                     zid
                                     [(:task_data task-record)]))))


(defmethod dispatch-task! :generate_export_data
  [{:as poller :keys [darwin]} task-record]
  (log/debug "Dispatching generate_export_data for" task-record)
  (let [params (assoc (:task_data task-record) :task_bucket (:task_bucket task-record))
        ;; Need to think about security implications more thoroughly before we can really include this from
        ;; requests triggered by server (needs thorough audit to make sure user can't trigger this via web
        ;; api request)
        params (dissoc task-record :include-xid)]
    (try
      (let [params (darwin/parsed-params darwin params)]
        (darwin/notify-of-status darwin params "processing")
        (export/export-conversation darwin params)
        (darwin/handle-completion! darwin params))
      (catch Exception e
        (log/error e (str "Error generating export data for " task-record ":"))
        (darwin/notify-of-status darwin (:task_data params) "failed")))))


(defmethod dispatch-task! :update_math
  [{:as poller :keys [darwin conversation-manager]} task-record]
  (log/debug "Dispatching update_math task for:" task-record)
  (async/thread
    (conv-man/queue-message-batch! conversation-manager :votes (-> task-record :task_data :zid) [])))


(defn poll
  [{:as poller :keys [config postgres kill-chan]}]
  (log/debug ">> Initializing task poller loop")
  (let [poller-config (-> config :poller)
        start-polling-from (- (System/currentTimeMillis) (* (:poll-from-days-ago poller-config) 1000 60 60 24))
        polling-interval (or (-> poller-config :tasks :polling-interval) 1000)]
    (async/thread
      (loop [last-timestamp start-polling-from]
        (log/debug "polling tasks from" last-timestamp)
        (when-not (async/poll! kill-chan) ;; TODO When we upgrade clojure & clojure.core.async, should do this
          (let [results (postgres/poll-tasks postgres last-timestamp)
                last-timestamp (apply max 0 last-timestamp (map :created results))]
            (log/debug "new last-timestamp" last-timestamp)
            ;; For each chunk of votes, for each conversation, send to the appropriate spout
            (doseq [task-record results]
              ;; TODO; Erm... need to sort out how we're using blocking vs non-blocking ops for threadability
              (log/debug "dispatch task" task-record)
              (dispatch-task! poller task-record))
            (<!! (async/timeout polling-interval))
            (log/debug "post timeout")
            ;; Update timestamp
            (recur last-timestamp)))))))


(defrecord TaskPoller [config darwin postgres conversation-manager kill-chan]
  component/Lifecycle
  (start [component]
    (log/info ">> Starting task poller component")
    (let [kill-chan (async/promise-chan)
          component (assoc component :kill-chan kill-chan)]
      (poll component)
      component))
  (stop [component]
    (log/info "<< Stopping task poller component")
    (go (>! kill-chan :kill))
    component))

(defn create-task-poller
  ([]
   (create-task-poller {}))
  ([options]
   (map->TaskPoller options)))

