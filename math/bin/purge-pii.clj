#!/usr/bin/env bb

(require '[babashka.pods :as pods]
         '[babashka.deps :as deps]
         '[clojure.pprint :as pp])

(pods/load-pod 'org.babashka/postgresql "0.0.1")
(deps/add-deps '{:deps {honeysql/honeysql {:mvn/version "1.0.444"}}})

(require '[pod.babashka.postgresql :as pg]
         '[honeysql.core :as hsql])



(def db-url
  (System/getenv "DATABASE_URL"))
db-url
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
    

;(def execute-sql!
  ;(partial pg/execute! (heroku-url-spec (System/getenv "DATABASE_URL"))))

(defn execute!
  [query-or-command]
  (execute-sql! (hsql/format query-or-command)))

(def email (first *command-line-args*))

(when-not email
  (println "Must call with an email argument")
  (System/exit 1))

(def user-record
  (first
    (execute!
      {:select [:*]
       :from [:users]
       :where [:= :email email]})))

(def uid (:users/uid user-record))

(if uid
  (println "Found uid:" uid)
  (println "Could not find uid for email address"))

(defn expunge-record
  [table where attrs]
  (execute!
    {:update table
     :where where
     :set (into {} (map #(vector %1 nil) attrs))}))

(when uid
  (println "Deleting user data:")
  (expunge-record :users [:= :uid uid] [:hname :email])
  (println "Deleting participants_extended data:")
  (expunge-record :participants_extended [:= :uid uid] [:subscribe_email]))

;; Should we delete their conversations as well
;; assuming leave IP address
;; Should maybe make sure we don't have their IP address from before we started saving encrypted


