(ns polismath.poller
  (:use clojure.pprint
        polismath.conversation
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
        last-timestamp  (atom 0)
        conversations   (atom {})]
    (endlessly poll-interval
      (let [new-votes (poll pg-spec @last-timestamp)
            split-votes (split-by-conv new-votes)]
        ;(println "polling:" split-votes)
        (doseq [[zid votes] split-votes]
          (swap! conversations
            (fn [convs]
              (assoc convs zid
                  (try
                    (small-conv-update {:conv (or (convs zid)
                                            {:rating-mat (named-matrix)})
                                    :votes votes
                                    :opts {}})
                      (catch Exception e (println "exception when processing zid: " zid))))))
              
          ;(upsert-results pg-spec 1001 1 "foo")
          (println "zid: " zid)
          (println "time: " (System/currentTimeMillis))
          (println "\n\n")
          (println (@conversations zid))
        (swap! last-timestamp (fn [_] (:created (last new-votes))))
      )))))
