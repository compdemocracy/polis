(ns polismath.poller
  (:use clojure.pprint
        polismath.utils)
  (:require [korma.core :as ko]
            [korma.db :as kdb]
            [clojure.tools.logging :as log]))


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


(defn poll [db-spec last-timestamp]
  (try
    (kdb/with-db db-spec
      (ko/select "votes"
        (ko/where {:created [> last-timestamp]})
        (ko/order [:zid :tid :pid :created] :asc))) ; ordering by tid is important, since we rely on this ordering to determine the index within the comps, which needs to correspond to the tid
    (catch Exception e
      (log/error "polling failed " (.getMessage e))
      [])))


