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


(defn mongo-upsert-results [collection-name zid timestamp new-results]
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


(defn format-conv-for-mongo [conv zid lastVoteTimestamp]
  (-> conv
    prep-for-uploading-bidToPid-mapping
    ; core.matrix & monger workaround: convert to str with cheshire then back
    generate-string
    parse-string
    (assoc
      "zid" zid
      "lastVoteTimestamp" lastVoteTimestamp)))


(defn -main []
  (println "launching poller " (System/currentTimeMillis))
  (metric "math.process.launch" 1)
  (let [poll-interval 1000
        pg-spec         (heroku-db-spec (env/env :database-url))
        mg-db           (mongo-connect! (env/env :mongo-url))
        last-timestamp  (atom 0)
        conversations   (atom {})]
    (endlessly poll-interval
      (println "poll >" @last-timestamp)
      ; Get and split new votes
      (let [new-votes (poll pg-spec @last-timestamp)
            zid-votes (group-by :zid new-votes)]
        ; For each conv...
        (doseq [[zid votes] zid-votes]
          (let [lastVoteTimestamp (:created (last votes))
                start (System/currentTimeMillis)]
            (swap! conversations
              (fn [convs]
                (try
                  (assoc convs zid
                    (conv-update (or (convs zid) (new-conv)) votes))
                  (catch Exception e
                    (do
                      (println "exception when processing zid: " zid)
                      (.printStackTrace e)
                      (let [end (System/currentTimeMillis)
                            duration (- end start)]
                        (metric "math.pca.compute.fail" duration))
                      ; Put things back the way they were
                      convs)))))

            ; Format and upload results
            (->> (format-conv-for-mongo (@conversations zid) zid lastVoteTimestamp)
              (mongo-upsert-results "polismath_bidToPid_april9" zid lastVoteTimestamp))))

        ; Update last-timestamp
        (swap! last-timestamp (fn [_] (:created (last new-votes))))))))


