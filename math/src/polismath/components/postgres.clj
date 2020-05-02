;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.components.postgres
  (:require [polismath.components.env :as env]
            [polismath.util.pretty-printers :as pp]
            [polismath.utils :as utils]
            [cheshire.core :as ch]
            ;; Replace with as util XXX
            ;[polismath.utils :as utils :refer :all]
            [clojure.stacktrace :refer :all]
            [taoensso.timbre :as log]
            [clojure.tools.trace :as tr]
            [com.stuartsierra.component :as component]
            [plumbing.core :as pc]
            [korma.db :as kdb]
            [cheshire.core :as cheshire]
            [clojure.java.jdbc :as jdbc]
            [honeysql.core :as sql]
            [honeysql.helpers :as honey]
            [honeysql.helpers :as sqlhelp])
  (:import (org.postgresql.util PGobject)))
            ;[alex-and-georges.debug-repl :as dbr]



(defn heroku-db-spec
  "Create a korma db-spec given a heroku db-uri"
  [db-uri ignore-ssl]
  (let [[_ user password host port db] (re-matches #"postgres://(?:(.+):(.*)@)?([^:]+)(?::(\d+))?/(.+)" db-uri)
        settings {:user user
                  :password password
                  :host host
                  :port (or port 80)
                  :db db
                  :ssl false
                  ;:ssl (-> ignore-ssl boolean not)
                  :sslfactory "org.postgresql.ssl.NonValidatingFactory"}]
        ;settings (if ignore-ssl
                   ;(merge settings {:sslfactory "org.postgresql.ssl.NonValidatingFactory"})
                   ;settings)]
    (kdb/postgres settings)))



;; The executor function for honeysql queries (which we'll be rewriting everything in over time)

(defn query
  "Takes a postgres component and a query, and executes the query. The query can either be a postgres vector, or a map.
  Maps will be compiled via honeysql/format."
  [component query-data]
  (if (map? query-data)
    (query component (sql/format query-data))
    (jdbc/query (:db-spec component) query-data)))

(defrecord Postgres [config db-spec]
  component/Lifecycle
  (start [component]
    (log/info ">> Starting Postgres component")
    (let [database-url (-> config :database :url)]
      (assert database-url "Missing database url. Make sure to set env variables.")
      (assoc component :db-spec (heroku-db-spec database-url (-> config :database :ignore-ssl)))))
  (stop [component]
    (log/info "<< Stopping Postgres component")
    (assoc component :db-spec nil)))

(defn create-postgres
  "Creates a new Postgres component"
  []
  (map->Postgres {}))


(defn poll
  "Query for all data since last-vote-timestamp, given a db-spec"
  [component last-vote-timestamp]
  (log/info "poll" last-vote-timestamp)
  (try
    (query component
           {:select [:*]
            :from [:votes]
            :order-by [:zid :tid :pid :created]
            :where [:> :created last-vote-timestamp]})
    (catch Exception e
      (log/error "polling failed " (.getMessage e))
      (.printStackTrace e)
      [])))


(defn mod-poll
  "Moderation query: basically look for when things were last modified, since this is the only time they will
  have been moderated."
  [component last-mod-timestamp]
  (log/info "modpoll" last-mod-timestamp)
  (try
    (query component
           {:select [:*]
            :from [:comments]
            :order-by [:zid :tid :modified]
            :where [:> :modified last-mod-timestamp]})
    (catch Exception e
      (log/error "moderation polling failed " (.getMessage e))
      [])))


(defn get-zid-from-zinvite
  [component zinvite]
  (log/debug "get-zid-from-zinvite for zinvite" zinvite)
  (->
    (query component
           {:select [:zid :zinvite]
            :from [:zinvites]
            :where [:= :zinvite zinvite]})
    first
    :zid))

(defn get-zinvite-from-zid
  [component zid]
  (log/debug "get-zinvite-from-zid for zid" zid)
  (->
    (query component
           {:select [:zid :zinvite]
            :from [:zinvites]
            :where [:= :zid zid]})
    first
    :zinvite))

(defn conv-poll
  "Query for all vote data since last-vote-timestamp for a given zid, given an implicit db-spec"
  [component zid last-vote-timestamp]
  (log/info "conv-poll for zid" zid ", last-vote-timestap" last-vote-timestamp)
  (try
    (query component
           {:select [:*]
            :from [:votes]
            :order-by [:zid :tid :pid :created]
            :where [:and
                    [:> :created last-vote-timestamp]
                    [:= :zid zid]]})
    (catch Exception e
      (log/error "polling failed for conv zid =" zid ":" (.getMessage e))
      (.printStackTrace e)
      [])))

(defn conv-mod-poll
  "Query for all mod data since last-vote-timestamp for a given zid, given an implicit db-spec"
  [component zid last-mod-timestamp]
  (log/info "conv-mod-poll for zid" zid ", last-vote-timestap" last-mod-timestamp)
  (query
    component
    {:select [:*]
     :from [:comments]
     :order-by [:tid :modified]
     :where [:and
             [:> :modified last-mod-timestamp]
             [:= :zid zid]]}))


(defn format-as-json-for-db
  "Formats data for pg json, first passing through a prep function which may strip out uneeded junk or
  reshape things. Takes conv and lastVoteTimestamp, though the latter may be moved into the former in update"
  [conv]
  (-> conv
      ; core.matrix & monger workaround: convert to str with cheshire then back
      ch/generate-string
      ch/parse-string))

; (defn collection-name
;   "math_env name based on math-env and math-schema-date config variables. Makes sure that
;   prod, preprod, dev (and subdevs like chrisdev or mikedev) have their own noninterfering collections."
;   ([mongo rootname]
;    (let [{:keys [math-schema-date math-env]} (:config mongo)
;          math-env (or math-env :dev)]
;      (str rootname "_" (name math-env) "_" math-schema-date)))
;   ([mongo rootname basename] (str (collection-name mongo rootname) "_" basename)))



(defn poll-tasks
  [component last-timestamp]
  (->>
    (query
      component
      (sql/format
        {:select [:*]
         :from [:worker_tasks]
         :where [:and
                 [:> :created last-timestamp]
                 [:= :math_env (-> component :config :math-env-string)]
                 [:= :finished_time nil]]}))
    (map (fn [task-record]
           (-> task-record
               (update :task_type keyword)
               (update :task_data (comp #(cheshire/parse-string % true) #(.toString %))))))))

(defn zid-from-rid
  [rid]
  {:select [:zid]
   :from [:reports]
   :where [:= :rid rid]})

(defn report-tids
  [rid]
  {:select [:tid]
   :from [:report_comment_selections]
   :where [:and
           [:= :rid rid]
           [:> :selection 0]]})

(defn ptpt-counts [postgres]
  (query
    postgres
    {:select [:*]
     :from [[{:select [:zid [:%count-distinct.pid :ptpt_cnt]]
              :from [:votes]
              :group-by [:zid]}
             :counts]]
     :where [:> :counts.ptpt_cnt 5]}))

(defn query-zid-from-rid [component rid]
  (query component (zid-from-rid rid)))

(defn inc-math-tick
  [postgres zid]
  (log/info "inc-math-tick" zid)
  (:math_tick (first (query postgres ["insert into math_ticks (zid, math_env) values (?, ?) on conflict (zid, math_env) do update set modified = now_as_millis(), math_tick = (math_ticks.math_tick + 1) returning math_tick;" zid (-> postgres :config :math-env-string)]))))

(defn pg-json
  [data]
  (doto (PGobject.)
        (.setType "json")
        (.setValue (cheshire/encode data))))

(defn insert-correlationmatrix!
  [postgres rid math-tick data]
  (query postgres ["insert into math_report_correlationmatrix (rid, math_env, math_tick, data) values (?,?,?,?) on conflict (rid, math_env) do update set data = excluded.data, math_tick = excluded.math_tick returning rid;" rid (-> postgres :config :math-env-string) math-tick (pg-json data)]))


;; TODO Fix this; need task-type in here as well for this to work
;(defn mark-task-complete!
;  [postgres task-type task-bucket]
;  (log/info "mark-task-complete called for task-type, task-bucket:" task-type task-bucket)
;  (jdbc/update!
;    (:db-spec postgres)
;    :worker_tasks
;    {:finished_time (System/currentTimeMillis)}
;    ["task_type = ? and task_bucket = ?" task-type task-bucket]))
;; Marks all tasks with the same task_bucket as done.
(defn mark-task-complete!
  [postgres task_type task_bucket]
  (log/info "mark-task-complete" task_bucket)
  (query postgres ["update worker_tasks set finished_time = now_as_millis() where math_env = (?) and task_type = (?) and task_bucket = (?) returning finished_time;" (-> postgres :config :math-env-string) task_type task_bucket]))

(defn upload-math-main
  [postgres zid math-tick data]
  (log/info "upload-math-main for zid" zid)
  (let [math-env (-> postgres :config :math-env-string)]
    (query postgres
           ["insert into math_main (zid, math_env, last_vote_timestamp, math_tick, data, caching_tick)
             values (?,?,?,?,?, COALESCE((select max(caching_tick) + 1 from math_main where math_env = (?)), 1))
             on conflict (zid, math_env)
             do update set modified = now_as_millis(),
                           data = excluded.data,
                           last_vote_timestamp = excluded.last_vote_timestamp,
                           math_tick = excluded.math_tick,
                           caching_tick = excluded.caching_tick
             returning zid;"
            ;; I believe math env is twice here because it gets used in two separate ?
            zid math-env (:lastVoteTimestamp data) math-tick (pg-json data) math-env])))

(defn upload-math-profile
  [postgres zid data]
  (log/info "upload-math-profile for zid" zid)
  (query postgres
         ["insert into math_profile (zid, math_env, data)
           values (?,?,?) on conflict (zid, math_env)
           do update set modified = now_as_millis(), data = excluded.data
           returning zid;"
          zid (-> postgres :config :math-env-string) (pg-json data)]))

(defn upload-math-ptptstats
  [postgres zid math-tick data]
  (log/info "upload-math-ptptstats for zid" zid)
  (query postgres
         ["insert into math_ptptstats (zid, math_env, math_tick, data)
           values (?,?,?,?)
           on conflict (zid, math_env)
           do update set modified = now_as_millis(),
                         data = excluded.data,
                         math_tick = excluded.math_tick
           returning zid;"
          zid (-> postgres :config :math-env-string) math-tick (pg-json data)]))

;; XXX Not using this anywhere apparently so should remove
;(defn upload-math-cache
;  [postgres zid data]
;  (log/info "upload-math-cache for zid" zid)
;  (query postgres ["insert into math_cache (zid, math_env, data) values (?,?,?) on conflict (zid, math_env) do update set modified = now_as_millis(), data = excluded.data returning zid;" zid (name (-> postgres :config :math-env)) (pg-json data)]))

(defn upload-math-bidtopid
  [postgres zid math-tick data]
  (log/info "upload-math-bidtopid for zid" zid)
  (query postgres
         ["insert into math_bidtopid (zid, math_env, math_tick, data)
           values (?,?,?,?)
           on conflict (zid, math_env)
           do update set modified = now_as_millis(),
                         data = excluded.data,
                         math_tick = excluded.math_tick
           returning zid;"
          zid (-> postgres :config :math-env-string) math-tick (pg-json data)]))

(defn upload-math-exportstatus
  [postgres zid filename data]
  {:pre [postgres zid filename data]}
  (log/info "upload-math-exportstatus for zid" zid)
  (query
    postgres
    ["insert into math_exportstatus (zid, math_env, filename, data, modified)
      values (?,?,?,?, now_as_millis())
      on conflict (zid, math_env)
      do update set modified = now_as_millis(),
                    data = excluded.data,
                    filename = excluded.filename
      returning zid;"
     zid
     (-> postgres :config :math-env-string)
     filename
     (pg-json data)]))


(defn decode-pg-json
  [data]
  (-> data .getValue cheshire/decode))

(defn get-math-exportstatus
  [postgres zid filename]
  (log/info "get-math-exportstatus for zid" zid)
  (->>
    (query postgres ["select * from math_exportstatus where zid = (?) and math_env = (?) and filename = (?);" zid (-> postgres :config :math-env-string) filename])
    first
    :data
    decode-pg-json))

(defn get-math-tick
  [postgres zid]
  (:math_tick (first (query postgres ["select math_tick from math_ticks where zid = (?) and math_env = (?);" zid (-> postgres :config :math-env-string)]))))


(defn load-conv
  "Very bare bones reloading of the conversation; no cleanup for keyword/int hash-map key mismatches,
  as found in the :repness"
  [postgres zid]
  (log/info "load-conv called for zid" zid)
  (let [row (first (query postgres ["select * from math_main where zid = (?) and math_env = (?);" zid (-> postgres :config :math-env-string)]))]
    (if row
      ;; TODO Make sure this loads with keywords for map keys, except where they should be integers
      (ch/parse-string
        (.toString (:data row))
        (fn [x]
          (try
            (Long/parseLong x)
            (catch Exception _
              (keyword x)))))
      row)))

  ; (mc/find-one-as-map
    ; (:db mongo)
    ; (math-collection-name mongo "main")
    ; {:zid zid}))


(comment
  (require '[polismath.runner :as runner])
  (def postgres (:postgres runner/system))
  (def config (:config postgres))
  (query postgres ["select * from zinvites limit 10"])

  (conv-poll postgres 18747 0)
  (get-zinvite-from-zid postgres 18747)
  (conv-mod-poll postgres 18747 0)
  (get-)


  (get-math-exportstatus postgres 15077 "polis-export-9ma5xnjxpj-1491632824548.zip")
  ;(query postgres ["insert into math_ticks (zid) values (?) on conflict (zid) do update set modified = now_as_millis(), math_tick = (math_ticks.math_tick + 1) returning *;" 12480])
  (poll-tasks postgres 0)
  (query
    postgres
    (-> (honey/update :worker_tasks)
        (honey/values [{}])))

  (jdbc/execute!
    (:db-spec postgres)
    (-> (honey/update :worker_tasks)
        (honey/value)))

  (try
    (mark-task-complete! postgres 1)
    (catch Exception e (log/error (.getNextException e))))


  (query
    postgres
    (report-tids 1))
  :endcomment)

:ok


