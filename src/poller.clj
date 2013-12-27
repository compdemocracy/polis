(ns poller
  (:use matrix-utils pca)
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


(defn -main []
  (let [poll-interval 1000
        db-url (env/env :database-url)
        pg (heroku-db-spec db-url)]
    (doseq [x (kdb/with-db pg
                (ko/select "votes"
                  (ko/order :created :asc)
                  (ko/limit 10)))]
      (println x))))


