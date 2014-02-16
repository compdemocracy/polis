(ns polismath.poller
  (:use clojure.pprint
        clojure.core.matrix.impl.ndarray
        polismath.conversation
        polismath.named-matrix
        polismath.utils
        polismath.pca)
  (:require [korma.db :as kdb]
            [korma.core :as ko]
            [cheshire.core :refer :all]
            [cheshire.generate :refer [add-encoder encode-seq remove-encoder]]
            [clojure.java.jdbc :as sql]
            [monger.core :as mg]
            [monger.collection :as mgcol]
            [environ.core :as env]))

;(use 'alex-and-georges.debug-repl)

(println "launching poller " (System/currentTimeMillis))

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



(defn split-by-conv [votes]
  (reduce
    (fn [conv-map vote]
      (let [conv-id (vote :zid)]
        (assoc conv-map conv-id
               (conj (get conv-map conv-id []) vote))))
    {} votes))


(defn mongo-connect! [mongo-url]
  (monger.core/connect-via-uri! mongo-url))

(defn mongo-upsert-results [zid timestamp new-results ]
  (monger.collection/update "polismath_test1248124"
    {
      :zid zid
      ; "$gt" 92839182312
    } 
    {
      "zid" zid
      "lastVoteTimestamp" timestamp
      "data" new-results
    }
    :multi false
    :upsert true))


; (defn post-results [db-spec zid last-timestamp results-json]
;   (kdb/with-db db-spec
;     (ko/update "math_results_dev01"
;       (ko/set-fields {
;         :data results-json
;         :last_timestamp last-timestamp })
;       (ko/where {
;         :zid [= zid]
;         :last_timestamp [< last-timestamp] }))))

; (defn post-results-raw [db-spec zid last-timestamp results-json]
;   (kdb/with-db db-spec
;     (ko/exec-raw [
;       "UPDATE math_results_dev01 SET data = ?, last_timestamp = ? WHERE zid = ? RETURNING zid"
;       [results-json last-timestamp zid]
;       :results])))


; (defn post-results-insert [db-spec zid last-timestamp results-json]
;   (kdb/with-db db-spec
;     (ko/insert "math_results_dev01"
;       (ko/values {
;         :data results-json
;         :last_timestamp last-timestamp
;         :zid zid}))))

; (defn upsert-results [db-spec zid last-timestamp results-json]
;   (try
;     (post-results-insert db-spec 1001 0 results-json)
;     (catch Exception e
;       (post-results db-spec 1001 1 results-json))))


(defn poll [db-spec last-timestamp]
  (try
    (kdb/with-db db-spec
      (ko/select "votes"
        (ko/where {:created [> last-timestamp]})
        (ko/order :created :asc)))
    (catch Exception e (do
        (println (str "polling failed " (.getMessage e)))
        []))))



(add-encoder mikera.vectorz.Vector
             (fn [v jsonGenerator]
               (encode-seq (into-array v) jsonGenerator)))

; CAREFUL - make sure we don't lose dimensions of the N-Dimensional array.
(add-encoder clojure.core.matrix.impl.ndarray.NDArray
             (fn [v jsonGenerator]
               (encode-seq (into-array v) jsonGenerator)))





(defn -main []
  (let [poll-interval 1000
        pg-spec         (heroku-db-spec (env/env :database-url))
        mg-db           (mongo-connect! (env/env :mongo-url))
        last-timestamp  (atom 0)
        conversations   (atom {})]
    (endlessly poll-interval
      (let [foo (println "poll > " @last-timestamp)
            new-votes (poll pg-spec @last-timestamp)
            split-votes (split-by-conv new-votes)]
        (doseq [[zid votes] split-votes]
          (let [lastVoteTimestamp (:created (last votes))]
            (swap! conversations
              (fn [convs]
                (assoc convs zid
                    (try
                      (conv-update (or (convs zid) {:rating-mat (named-matrix)}) votes)
                      (catch Exception e (println "exception when processing zid: " zid))))))
                
            ;(upsert-results pg-spec 1001 1 "foo")
            (println "zid: " zid)
            (println "time: " (System/currentTimeMillis))
            (println "\n\n")
            (println (generate-string (prep-for-uploading (@conversations zid))))
            ; (debug-repl)
            (println 
              (mongo-upsert-results
                zid
                lastVoteTimestamp
                (generate-string
                  (prep-for-uploading
                    (@conversations zid)))))
        (swap! last-timestamp (fn [_] (:created (last new-votes))))
      ))))))
