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


(defn mongo-connect! [mongo-url]
  (monger.core/connect-via-uri! mongo-url))


(defn mongo-upsert-results [collection-name zid timestamp new-results ]
  (monger.collection/update collection-name
    {
      :zid zid
      ; "$gt" 92839182312
    } 
    new-results
    :multi false
    :upsert true))


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


(defn new-conv []
  {:rating-mat (named-matrix)})


(defn -main []
  (println "launching poller " (System/currentTimeMillis))
  (let [poll-interval 1000
        pg-spec         (heroku-db-spec (env/env :database-url))
        mg-db           (mongo-connect! (env/env :mongo-url))
        last-timestamp  (atom 0)
        conversations   (atom {})]
    (endlessly poll-interval
      (println "poll >" @last-timestamp)
      (let [new-votes (poll pg-spec @last-timestamp)
            zid-to-votes (group-by :zid new-votes)
            zid-votes (shuffle (into [] zid-to-votes))
            ]
        (doseq [[zid votes] zid-votes]
          (let [lastVoteTimestamp (:created (last votes))]
            (swap! conversations
              (fn [convs]
                (try
                  (assoc convs zid
                         (do
                           (println "zid: " zid)
                           (let [foo (conv-update (or (convs zid) (new-conv)) votes)]
                             (pprint foo)
                             foo)))
                  (catch Exception e
                    (do
                      (println "exception when processing zid: " zid)
                      (.printStackTrace e)
                      @conversations ; put things back 
                      )))))
            
                
            (println "zid: " zid)
            (println "time: " (System/currentTimeMillis))
            (println "\n\n")

            (let [conv (@conversations zid)]
              (if-not (nil? conv)
                (do
                  
            ; Upload pid mapping NOTE: uploading before primary
            ; results since client triggers resuest for pid mapping in
            ; response to a new primary math result, so there is race.
            (let [
              ; For now, convert to json and back (using cheshire to cast NDArray and Vector)
              ; This is a quick-n-dirty workaround for Monger's missing supoort for these types.
                  json (generate-string
                        (prep-for-uploading-bidToPid-mapping
                         (@conversations zid)))
              obj (parse-string json)] 

              (println json)
              (println
               (mongo-upsert-results
                "polismath_bidToPid_test_mar14"
                zid
                lastVoteTimestamp
                (assoc obj
                 "lastVoteTimestamp" lastVoteTimestamp
                 "zid" zid))))
            
            ; Upload primary math results
            (let [
              ; For now, convert to json and back (using cheshire to cast NDArray and Vector)
              ; This is a quick-n-dirty workaround for Monger's missing supoort for these types.
                  json (generate-string
                        (prep-for-uploading-to-client
                         (@conversations zid)))
              obj (parse-string json)] 

              (println json)
              ; (debug-repl)
              (println
               (mongo-upsert-results
                "polismath_test_mar02"
                zid
                lastVoteTimestamp
                (assoc obj
                 "lastVoteTimestamp" lastVoteTimestamp
                 "zid" zid))))                  
                  )))
            


            
        (swap! last-timestamp (fn [_] (:created (last new-votes))))

      ))))))
