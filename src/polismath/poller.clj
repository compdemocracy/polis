(ns polismath.poller
  (:use 
        clojure.pprint
        polismath.named-matrix
        polismath.utils
        polismath.pca)
  (:require [korma.db :as kdb]
            [korma.core :as ko]
            [clojure.java.jdbc :as sql]
            [monger.core :as mg]
            [monger.collection :as mg.col]
            [environ.core :as env]))


(defn heroku-db-spec [db-uri]
  (let [[_ user password host port db] (re-matches #"postgres://(?:(.+):(.*)@)?([^:]+)(?::(\d+))?/(.+)" db-uri)
        settings {:user user
                  :password password
                  :host host
                  :port (or port 80)
                  :db db
                  :ssl true
                  :sslfactory "org.postgresql.ssl.NonValidatingFactory"}]
    (kdb/postgres settings)))


(defn mongo-db [env-vars]
  (let [params  {}
        con     (mg/connect params)]
    (mg/get-db con "polismath")))


(defn split-by-conv [votes]
  (reduce
    (fn [conv-map vote]
      (let [conv-id (vote :zid)]
        (assoc conv-map conv-id
               (conj (get conv-map conv-id []) vote))))
    {} votes))

(defn post-results [db-spec zid last-timestamp results-json]
  (kdb/with-db db-spec
    (ko/update "math_results_dev01"
      (ko/set-fields {
        :data results-json
        :last_timestamp last-timestamp })
      (ko/where {
        :zid [= zid]
        :last_timestamp [< last-timestamp] }))))

(defn post-results-raw [db-spec zid last-timestamp results-json]
  (kdb/with-db db-spec
    (ko/exec-raw [
      "UPDATE math_results_dev01 SET data = ?, last_timestamp = ? WHERE zid = ? RETURNING zid"
      [results-json last-timestamp zid]
      :results])))


(defn post-results-insert [db-spec zid last-timestamp results-json]
  (kdb/with-db db-spec
    (ko/insert "math_results_dev01"
      (ko/values {
        :data results-json
        :last_timestamp last-timestamp
        :zid zid}))))

(defn upsert-results [db-spec zid last-timestamp results-json]
  (try
    (post-results-insert db-spec 1001 0 results-json)
    (catch Exception e
      (post-results db-spec 1001 1 results-json))))


(defn poll [db-spec last-timestamp]
  (kdb/with-db db-spec
    (ko/select "votes"
      (ko/where {:created [> last-timestamp]})
      (ko/order :created :asc))))


(defn -main []
  (let [poll-interval 1000
        pg-spec         (heroku-db-spec (env/env :database-url))
        mg-db           (mongo-db env/env)
        last-timestamp  (atom 1388285552490)]
    (endlessly poll-interval
      (let [new-votes (poll pg-spec @last-timestamp)
            split-votes (split-by-conv new-votes)
            ; results (small-conv-update {
                      ; :conv conv 
                      ; :opts {}
                             ; :votes (get split-votes 451)})
            ]
        (println "polling:" split-votes)
        (swap! last-timestamp (fn [_] (:created (last new-votes))))
        ; want to upsert, using try-catch instead. try 
        (upsert-results pg-spec 1001 1 "foo")
        ))))


