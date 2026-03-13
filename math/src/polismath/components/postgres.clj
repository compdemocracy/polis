;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.components.postgres
  (:require
   [cheshire.core :as cheshire]
   [clojure.java.jdbc :as jdbc]
   [com.stuartsierra.component :as component]
   [honeysql.core :as sql]
   [honeysql.helpers :as honey]
   [taoensso.timbre :as log])
  (:import
   (com.zaxxer.hikari HikariConfig HikariDataSource)
   (org.postgresql.util PGobject)))



(defn create-hikari-datasource
  "Create a HikariCP datasource for better connection pooling"
  [db-uri pool-config]
  (let [[_ user password host port db] (re-matches #"postgres://(?:(.+):(.*)@)?([^:]+)(?::(\d+))?/(.+)" db-uri)
        pool-size (get pool-config :pool-size 10)
        config (doto (HikariConfig.)
                 (.setJdbcUrl (str "jdbc:postgresql://" host ":" (or port 5432) "/" db))
                 (.setUsername user)
                 (.setPassword password)
                 (.setDriverClassName "org.postgresql.Driver")
                 ;; Connection pool settings optimized for concurrent workloads
                 (.setMaximumPoolSize pool-size)
                 (.setMinimumIdle (max 1 (int (/ pool-size 4))))  ; 25% of max as minimum
                 (.setConnectionTimeout 30000)      ; 30 seconds
                 (.setIdleTimeout 600000)           ; 10 minutes
                 (.setMaxLifetime 1800000)          ; 30 minutes
                 (.setLeakDetectionThreshold 60000) ; 1 minute - helps detect connection leaks
                 ;; Validation settings
                 (.setConnectionTestQuery "SELECT 1")
                 (.setValidationTimeout 5000)
                 ;; Performance optimizations
                 (.addDataSourceProperty "cachePrepStmts" "true")
                 (.addDataSourceProperty "prepStmtCacheSize" "250")
                 (.addDataSourceProperty "prepStmtCacheSqlLimit" "2048")
                 (.addDataSourceProperty "useServerPrepStmts" "true")
                 (.addDataSourceProperty "useLocalSessionState" "true")
                 (.addDataSourceProperty "rewriteBatchedStatements" "true")
                 (.addDataSourceProperty "cacheResultSetMetadata" "true")
                 (.addDataSourceProperty "cacheServerConfiguration" "true")
                 (.addDataSourceProperty "elideSetAutoCommits" "true")
                 (.addDataSourceProperty "maintainTimeStats" "false"))]
    (HikariDataSource. config)))

(defn heroku-db-spec
  "Create a korma db-spec given a heroku db-uri with HikariCP connection pooling"
  [db-uri _ignore-ssl pool-config]  ; ignore-ssl parameter kept for compatibility but not used with HikariCP
  (let [datasource (create-hikari-datasource db-uri pool-config)]
    {:datasource datasource}))



;; The executor function for honeysql queries (which we'll be rewriting everything in over time)

(defn health-check
  "Check if the database connection is healthy"
  [component]
  (try
    (let [result (jdbc/query (:db-spec component) ["SELECT 1 as health"])]
      (= 1 (:health (first result))))
    (catch Exception e
      (log/error "Database health check failed:" (.getMessage e))
      false)))

(defn query-with-retry
  "Execute a query with retry logic for connection failures"
  [component query-data & [retry-count]]
  (let [max-retries (or retry-count 3)]
    (loop [attempts 0]
      (let [result (try
                     {:success (if (map? query-data)
                                 (jdbc/query (:db-spec component) (sql/format query-data))
                                 (jdbc/query (:db-spec component) query-data))}
                     (catch java.sql.SQLException e
                       (if (and (< attempts max-retries)
                                (or (.contains (.getMessage e) "connection")
                                    (.contains (.getMessage e) "timeout")))
                         {:retry true :error e :attempts attempts}
                         {:error e}))
                     (catch Exception e
                       {:error e}))]
        (cond
          (:success result) (:success result)
          (:retry result) (do
                            (log/warn "Database query failed, retrying... attempt" (inc (:attempts result)) ":" (.getMessage (:error result)))
                            (Thread/sleep (* 1000 (inc (:attempts result))))  ; Exponential backoff
                            (recur (inc (:attempts result))))
          :else (do
                  (log/error "Database query failed:" (.getMessage (:error result)))
                  (throw (:error result))))))))

(defn query
  "Takes a postgres component and a query, and executes the query. The query can either be a postgres vector, or a map.
  Maps will be compiled via honeysql/format."
  [component query-data]
  (query-with-retry component query-data))

(defrecord Postgres [config db-spec]
  component/Lifecycle
  (start [component]
    (log/info ">> Starting Postgres component")
    (let [database-url (-> config :database :url)
          pool-config (-> config :database)]
      (assert database-url "Missing database url. Make sure to set env variables.")
      (log/info "Configuring PostgreSQL connection pool with size:" (get pool-config :pool-size 10))
      (assoc component :db-spec (heroku-db-spec database-url
                                                (-> config :database :ignore-ssl)
                                                pool-config))))
  (stop [component]
    (log/info "<< Stopping Postgres component")
    ;; Properly close the HikariCP connection pool
    (when-let [db-spec (:db-spec component)]
      (try
        (when-let [datasource (:datasource db-spec)]
          (log/info "Closing HikariCP connection pool")
          (when (instance? HikariDataSource datasource)
            (.close ^HikariDataSource datasource)))
        (catch Exception e
          (log/warn "Error closing connection pool:" (.getMessage e)))))
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

(defn get-meta-tids
  [component zid]
  (->>
   (query component
          {:select [:tid]
           :from [:comments]
           :where [:and [:= :zid zid]
                   :is_meta]})
   (map :tid)
   (into #{})))

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
      cheshire/generate-string
      cheshire/parse-string))



;; The following functions use math_env in SQL queries as a database field
;; This is a legacy database schema field that is kept for compatibility with "prod" environment

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
              [:= :math_env "prod"]
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
  (:math_tick (first (query postgres ["insert into math_ticks (zid, math_env) values (?, ?) on conflict (zid, math_env) do update set modified = now_as_millis(), math_tick = (math_ticks.math_tick + 1) returning math_tick;" zid "prod"]))))

(defn pg-json
  [data]
  (doto (PGobject.)
    (.setType "json")
    (.setValue (cheshire/encode data))))

(defn insert-correlationmatrix!
  [postgres rid math-tick data]
  (query postgres ["insert into math_report_correlationmatrix (rid, math_env, math_tick, data) values (?,?,?,?) on conflict (rid, math_env) do update set data = excluded.data, math_tick = excluded.math_tick returning rid;" rid "prod" math-tick (pg-json data)]))


;; Marks all tasks with the same task_bucket as done.
(defn mark-task-complete!
  [postgres task_type task_bucket]
  (log/info "mark-task-complete" task_bucket)
  (query postgres ["update worker_tasks set finished_time = now_as_millis() where math_env = (?) and task_type = (?) and task_bucket = (?) returning finished_time;" "prod" task_type task_bucket]))

(defn upload-math-main
  [postgres zid math-tick data]
  (log/info "upload-math-main for zid" zid)
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
          zid "prod" (:lastVoteTimestamp data) math-tick (pg-json data) "prod"]))

(defn upload-math-profile
  [postgres zid data]
  (log/info "upload-math-profile for zid" zid)
  (query postgres
         ["insert into math_profile (zid, math_env, data)
           values (?,?,?) on conflict (zid, math_env)
           do update set modified = now_as_millis(), data = excluded.data
           returning zid;"
          zid "prod" (pg-json data)]))

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
          zid "prod" math-tick (pg-json data)]))

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
          zid "prod" math-tick (pg-json data)]))

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
    "prod"
    filename
    (pg-json data)]))


(defn decode-pg-json
  [data]
  (-> data .getValue cheshire/decode))

(defn get-math-exportstatus
  [postgres zid filename]
  (log/info "get-math-exportstatus for zid" zid)
  (->>
   (query postgres ["select * from math_exportstatus where zid = (?) and math_env = (?) and filename = (?);" zid "prod" filename])
   first
   :data
   decode-pg-json))

(defn get-math-tick
  [postgres zid]
  (:math_tick (first (query postgres ["select math_tick from math_ticks where zid = (?) and math_env = (?);" zid "prod"]))))


(defn load-conv
  "Very bare bones reloading of the conversation; no cleanup for keyword/int hash-map key mismatches,
  as found in the :repness"
  [postgres zid]
  (log/info "load-conv called for zid" zid)
  (let [row (first (query postgres ["select * from math_main where zid = (?) and math_env = (?);" zid "prod"]))]
    (if row
      ;; TODO Make sure this loads with keywords for map keys, except where they should be integers
      (cheshire/parse-string
       (.toString (:data row))
       (fn [x]
         (try
           (Long/parseLong x)
           (catch Exception _
             (keyword x)))))
      row)))


(comment
  (require '[polismath.runner :as runner])
  (def postgres (:postgres runner/system))
  (def config (:config postgres))
  (query postgres ["select * from zinvites limit 10"])

  (conv-poll postgres 18747 0)
  (get-zinvite-from-zid postgres 18747)
  (conv-mod-poll postgres 18747 0)


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
    (mark-task-complete! postgres :task-type 1)  ; Fixed: added missing task-type parameter
    (catch Exception e (log/error (.getNextException e))))


  (query
   postgres
   (report-tids 1))
  :endcomment)

:ok


