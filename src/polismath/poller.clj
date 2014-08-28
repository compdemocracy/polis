(ns polismath.poller
  (:use clojure.pprint
        clojure.core.matrix.impl.ndarray
        polismath.conversation
        polismath.named-matrix
        polismath.utils
        polismath.pca
        polismath.metrics)
  (:require [polismath.conv-man :as cm]
            [korma.core :as ko]
            [cheshire.core :refer :all]
            [cheshire.generate :refer [add-encoder encode-seq remove-encoder]]
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


(defn poll [db-spec last-timestamp]
  (try
    (kdb/with-db db-spec
      (ko/select "votes"
        (ko/where {:created [> last-timestamp]})
        (ko/order [:zid :tid :pid :created] :asc))) ; ordering by tid is important, since we rely on this ordering to determine the index within the comps, which needs to correspond to the tid
    (catch Exception e (do
        (println (str "polling failed " (.getMessage e)))
        []))))


