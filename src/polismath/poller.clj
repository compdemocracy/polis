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
            [clojure.tools.trace :as tr]            
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


(defn mongo-upsert-results [zid timestamp new-results ]
  (monger.collection/update "polismath_test_mar02"
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


(def poll-interval 1000)
(def pg-spec         (heroku-db-spec (env/env :database-url)))
(def mg-db           (mongo-connect! (env/env :mongo-url)))
(def last-timestamp  (atom 0))
(def conversations   (atom {})) ; generated artifacts
(def pending-votes   (ref {})) ; zid -> votes

(def dinner-bell (Object.))
(def active-zids (ref #{}))
(def pending-votes (ref {})) ; zid -> new votes

(defn notify-workers []
  (locking dinner-bell
    (.notifyAll dinner-bell)))

(defn wait-for-dinner-bell []
  (locking dinner-bell
    (.wait dinner-bell)))

(defn pending-inactive-zids []
  (filter (fn [zid] (not (contains? @active-zids zid)))
          (keys @pending-votes)))

(defn should-take-votes []
  (> (count (pending-inactive-zids)) 0))

(defn should-not-take-votes []
  (not (should-take-votes)))


(defn make-worker-thread [id]
 (fn [] ;; closure to capture the id
  (do
    (println "starting worker thread" id)
   (while #(true)
     (do
       (println "worker" id "checking for votes")
    ; if there are votes pending, take a zid and go for it.
    ; otherwise, wait for a notification
    (while (should-not-take-votes)
      (do
        (println "worker" id "no votes to take")
        (wait-for-dinner-bell)))
    ;
    (let [
          [zid votes]
          (dosync
           ; TODO ensure that we actually get votes here.
           (let [zid (first (shuffle (pending-inactive-zids)))
                 votes (@pending-votes zid)]
             (do
               (ref-set pending-votes (dissoc @pending-votes zid))
               (ref-set active-zids (conj @active-zids zid))
               (vector zid votes))))]

      (println "worker thread" id "starting on math for zid:" zid)

      
    ; DO MATH
      (swap!
       conversations
       (fn [convs]
         (assoc convs zid
                (try
                  (do
                    (conv-update (or (convs zid) {:rating-mat (named-matrix)}) votes))
                  (catch Exception e
                    (do
                      (println "exception when processing zid: " zid)
                      (.printStackTrace e)))))))
      

    ; UPLOAD/PUBLISH - do this in worker thread so we don't start more
    ; work on a zid before we upload the result. That may be a later optimization.

      (let [lastVoteTimestamp (:created (last votes))]
          (println "zid: " zid)
            (println "time: " (System/currentTimeMillis))
            (println "\n\n")
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
                zid
                lastVoteTimestamp
                (assoc obj
                 "lastVoteTimestamp" lastVoteTimestamp
                 "zid" zid))))
            )

      (println "worker thread" id "finished zid" zid)
      (dosync ; do-sync needed?
       (ref-set active-zids (disj @active-zids zid)))
  ))))))


(defn merge-pending-votes [zid-votes-pairs]
  (dosync ;; dosync needed?
   (ref-set pending-votes
    (reduce
     (fn [o zid-vote-pair]
       (let [zid (first zid-vote-pair) votes (second zid-vote-pair)]
         (assoc o zid
                (concat (or (get o zid) [])
                        votes))))
     @pending-votes
     zid-votes-pairs
     ))))


(defn -main []
  (println "launching poller " (System/currentTimeMillis))

  (let [threads (map #(Thread. %1)
                     (map make-worker-thread
                          (range 4)))]
    (println (map #(.start %1) threads))
    )


  (endlessly poll-interval
      (println "poll >" @last-timestamp)
      (let [new-votes (poll pg-spec @last-timestamp)
            zid-to-votes (group-by :zid new-votes)
            zid-votes (into [] zid-to-votes)
            ]
        (if (> (count zid-votes) 0)
          (do
            (println "poller found new votes for" (count zid-votes) "conversations.")
            (merge-pending-votes zid-votes)
            (notify-workers)
            (swap! last-timestamp (fn [_] (:created (last new-votes))))))

        )))
