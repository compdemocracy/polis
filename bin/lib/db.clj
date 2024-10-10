(ns lib.db
  "Database utilities for clj bin/ scripts"
  (:require [babashka.pods :as pods]
            [babashka.deps :as deps]
            [clojure.pprint :as pp]
            [clojure.tools.cli :as cli]
            [clojure.java.io :as io]
            [clojure.string :as string]))

(pods/load-pod 'org.babashka/postgresql "0.0.1")
(deps/add-deps '{:deps {com.github.seancorfield/honeysql {:mvn/version "2.5.1103"}}})

(require '[pod.babashka.postgresql :as pg]
         '[honey.sql :as sql]
         '[honey.sql.helpers :as sqlh])


(def db-url
  (System/getenv "DATABASE_URL"))

(defn heroku-url-spec [db-url]
  (let [[_ user password host port db] (re-matches #"postgres://(?:(.+):(.*)@)?([^:]+)(?::(\d+))?/(.+)" db-url)]
    {:dbtype "postgresql"
     :host host
     :dbname db
     :port (or port 80)
     :user user
     :password password}))

(defn execute-sql! [args]
  (println "Executing sql:" args)
  (pg/execute!
    (heroku-url-spec (System/getenv "DATABASE_URL"))
    args))

(defn execute!
  [query-or-command]
  (execute-sql! (sql/format query-or-command)))


(defn insert!
  [table values]
  (execute! {:insert-into table
             :values values}))

(defn upsert!
  [table constraint values]
  (sqlh/on-constraint :xid_whitelist_owner_xid_key)
  (execute!
    {:insert-into table
     :values values
     :on-conflict {:on-constraint constraint}
     :do-nothing true}))


(defn get-email-uid [email]
  (:users/uid
    (first
      (execute!
        {:select [:*]
         :from [:users]
         :where [:= :email email]}))))

(defn get-zinvite-zid [zinvite]
  (:zinvites/zid
    (first
      (execute!
        {:select [:*]
         :from [:zinvites]
         :where [:= :zinvite zinvite]}))))

