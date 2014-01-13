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


(defn conversation [rating-matrix ptpt-pca ptpt-clusters]
  {:rating-matrix rating-matrix
   :ptpt-pca      ptpt-pca
   :ptpt-clusters ptpt-clusters
   :update
     (fn [votes & {:keys [n-comps pca-iters] :or {n-comps 2
                                                  pca-iters 10
                                                  cluster-iters 10}}]
       (let [rating-matrix (update-rating-matrix rating-matrix
                             (map #(map % [:pid :tid :vote]) votes))
             ptpt-pca      (powerit-pca rating-matrix n-comps
                                        :start-vectors ptpt-pca
                                        :iters pca-iters)
             ptpt-proj     (pca-project rating-matrix ptpt-pca)
             ptpt-clusters {}]
         (conversation rating-matrix ptpt-pca ptpt-clusters)))
   :partial-update
     (fn [votes & {:keys [iters learning-rate] :or {iters 10
                                                    learning-rate 0.01}}]
       '(let [_ _] _))})


(defn poll [db-spec last-timestanp]
  (kdb/with-db db-spec
    (ko/select "votes"
      (ko/where {:created [> last-timestanp]})
      (ko/order :created :asc))))


(defmacro endlessly [interval & forms]
  `(doseq [~'x (range)]
     ~@forms
     (Thread/sleep ~interval)))


(defn -main []
  (let [poll-interval 1000
        pg-spec         (heroku-db-spec (env/env :database-url))
        mg-db           (mongo-db env/env)
        last-timestanp  (atom 1388285552490)]
    (endlessly poll-interval
      (let [new-votes (poll pg-spec @last-timestanp)
            split-votes (split-by-conv new-votes)]
        (println "polling:" split-votes)
        (swap! last-timestanp (fn [_] (:created (last new-votes))))))))


