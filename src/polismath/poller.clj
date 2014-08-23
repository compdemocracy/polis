(ns polismath.poller
  (:use clojure.pprint
        clojure.core.matrix.impl.ndarray
        polismath.conversation
        polismath.named-matrix
        polismath.utils
        polismath.pca
        polismath.metrics)
  (:require [korma.db :as kdb]
            [korma.core :as ko]
            [cheshire.core :refer :all]
            [cheshire.generate :refer [add-encoder encode-seq remove-encoder]]
            [clojure.java.jdbc :as sql]
            [monger.core :as mg]
            [monger.collection :as mgcol]
            [environ.core :as env]))


(def metric (make-metric-sender "carbon.hostedgraphite.com" 2003 (env/env :hostedgraphite-apikey)))

(defmacro meter
  [metric-name & expr]
  `(let [start# (System/currentTimeMillis)
         ret# ~@expr
         end# (System/currentTimeMillis)
         duration# (- end# start#)]
     (metric ~metric-name duration# end#)
     (println (str end# " " ~metric-name " " duration# " millis"))
     ret#))

(metric "math.process.launch" 1)


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


(defn mongo-collection-name [basename]
  (let [schema-date "2014_08_22"
        env-name    (or (env/env :math-env) "dev")]
    (str "math_" env-name "_" schema-date "_" basename)))


(defn mongo-connect! [mongo-url]
  (monger.core/connect-via-uri! mongo-url))


(defn mongo-upsert-results [collection-name zid timestamp new-results ]
  (monger.collection/update collection-name
    {
      :zid zid
      ; "$gt" 92839182312
    } 
    (assoc new-results
           "zid" zid
           "lastVoteTimestamp" timestamp)
    :multi false
    :upsert true))


(defn poll [db-spec last-timestamp]
  (try
    (kdb/with-db db-spec
      (ko/select "votes"
        (ko/where {:created [> last-timestamp]})
        (ko/order [:zid :tid :pid :created] :asc))) ; ordering by tid is important, since we rely on this ordering to determine the index within the comps, which needs to correspond to the tid
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
        mg-db           (mongo-connect! (env/env :mongolab-uri))
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
                (let [start (System/currentTimeMillis)]
                  (try
                    (metric "math.pca.compute.go" 1)
                    (assoc convs zid
                           (do
                             (println "zid: " zid)
                             (let [foo (conv-update (or (convs zid) (new-conv)) votes)
                                   end (System/currentTimeMillis)
                                   duration (- end start)]
                               (metric "math.pca.compute.ok" duration)
                               foo)))
                  (catch Exception e
                    (do
                      (println "exception when processing zid: " zid)
                      (.printStackTrace e)
                      
                      (let [end (System/currentTimeMillis)
                            duration (- end start)]
                        (metric "math.pca.compute.fail" duration))
                      @conversations ; put things back 
                      ))))))
            
                
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
              
              (meter
                "db.math.bidToPid.put"
                (mongo-upsert-results
                  (mongo-collection-name "bidToPid")
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
              (meter
               "db.math.pca.put"
               (mongo-upsert-results
                  (mongo-collection-name "main")
                zid
                lastVoteTimestamp
                (assoc obj
                  "lastVoteTimestamp" lastVoteTimestamp
                  "zid" zid)))
              ))))
            

            

            
        (swap! last-timestamp (fn [_] (:created (last new-votes))))

      ))))))
