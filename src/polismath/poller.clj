(ns polismath.poller
  (:use
        clj-logging-config.log4j   
        clojure.pprint
        clojure.core.matrix.impl.ndarray
        clojure.tools.logging 
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


(set-logger!)

(info "Just a plain logging message")

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



(def conversations (atom {})) ; Will contain zid -> agent(data)

(def pending-votes (ref {})) ; zid -> [votes]

(defn make-math-updater [zid]
  (fn [conv]
    (let [votes (dosync
                 (let [votes ((deref pending-votes) zid)]
                   (ref-set pending-votes (dissoc (deref pending-votes) zid))
                   votes))]
      (if (empty? votes)
        conv ; No new votes to process, return conv as-is
        (let [start (System/currentTimeMillis)
              conv2 (conv-update conv votes)
              end (System/currentTimeMillis)
              duration (- end start)]
          (metric "math.pca.compute.ok" duration)
          (println conv2)
          
          (if (> (:lastVoteTimestamp conv2) (:lastVoteTimestamp conv)) ; basic sanity check. else don't modify.
            conv2
            conv))))))

(defn bid-to-pid-uploader [key iref old_conv conv]
  (println "bid-to-pid-uploader " (:zid conv))
  (println "bid-to-pid-uploader " conv)  
            ; Upload pid mapping NOTE: uploading before primary
            ; results since client triggers resuest for pid mapping in
            ; response to a new primary math result, so there is race.
  (let [
              ; For now, convert to json and back (using cheshire to cast NDArray and Vector)
              ; This is a quick-n-dirty workaround for Monger's missing supoort for these types.
        lastVoteTimestamp (conv :lastVoteTimestamp)
        json (generate-string (prep-for-uploading-bidToPid-mapping conv))
        obj (parse-string json)]
    
    (meter
     "db.math.bidToPid.put"
     (mongo-upsert-results
      "polismath_bidToPid_april9"
      (conv :zid)
      (conv :lastVoteTimestamp)
      obj))))

(defn math-uploader [key iref old_conv conv]
  (println "math-uploader " (:zid conv))
  (println "math-uploader " conv)  
                                        ; Upload primary math results
  (let [
              ; For now, convert to json and back (using cheshire to cast NDArray and Vector)
              ; This is a quick-n-dirty workaround for Monger's missing supoort for these types.
        json (generate-string
              (prep-for-uploading-to-client conv))
        obj (parse-string json)] 
    (meter
     "db.math.pca.put"
     (mongo-upsert-results
      "polismath_test_april9"
      (conv :zid)
      (conv :lastVoteTimestamp)
      obj))))


(defn new-conv [zid lastVoteTimestamp]
  {:rating-mat (named-matrix)
   :zid zid
   :lastVoteTimestamp lastVoteTimestamp})


(defn init-conv-agent [zid]
  (swap! conversations
         (fn [cs]
           (println "init-conv-agent" zid)
           (assoc cs
             zid
             (agent (new-conv zid 0)))))
  
  (let [a (@conversations zid)]
    (add-watch a :bid-to-pid-uploader-watch bid-to-pid-uploader)
    (add-watch a :math-uploader-watch math-uploader)
    a))

(defn -main []
  (println "launching poller " (System/currentTimeMillis))
  (let [poll-interval 1000
        pg-spec         (heroku-db-spec (env/env :database-url))
        mg-db           (mongo-connect! (env/env :mongo-url))
        last-timestamp  (atom 0)]
    (endlessly poll-interval
      (println "poll >" @last-timestamp)
      (let [new-votes (poll pg-spec @last-timestamp)
            zid-to-votes (group-by :zid new-votes)
            zid-votes (shuffle (into [] zid-to-votes))
            ]
        (doseq [[zid votes] zid-votes]
          (let [
                a (or (@conversations zid)
                      (init-conv-agent zid))
                ]

            (dosync
             (let [old (deref pending-votes)]
               (ref-set
                pending-votes
                (assoc old
                  zid (if (nil? (old zid))
                        votes
                        (concat (old zid) votes))))))
            
            ;; Clear old errors.
            (let [old-error  (agent-error a)]
              (if (not (nil? old-error))
                (do (println old-error)
                    (println "AGENT ERROR!")
                    (.printStackTrace old-error)
                    (restart-agent a @a))))
            
            ;; Enqueue the votes on the agent for that conversation.            
            (send a (make-math-updater zid))
            
            
            (println "zid: " zid)
            (println "time: " (System/currentTimeMillis))
            (println "\n\n")
            ))
        
        (swap! last-timestamp
               (fn [_]
                 (let [new-last-timestamp (:created (last new-votes))]
                   (if (nil? new-last-timestamp)
                     @last-timestamp
                     new-last-timestamp)
                   )))
        ))))
