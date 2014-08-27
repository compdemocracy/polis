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

(add-encoder mikera.vectorz.Vector
             (fn [v jsonGenerator]
               (encode-seq (into-array v) jsonGenerator)))

; CAREFUL - make sure we don't lose dimensions of the N-Dimensional array.
(add-encoder clojure.core.matrix.impl.ndarray.NDArray
             (fn [v jsonGenerator]
               (encode-seq (into-array v) jsonGenerator)))


(defn -main []
  (println "launching poller " (System/currentTimeMillis))
  (cm/metric "math.process.launch" 1)
  (let [poll-interval 1000
        pg-spec         (cm/heroku-db-spec (env/env :database-url))
        mg-db           (cm/mongo-connect! (env/env :mongolab-uri))
        last-timestamp  (atom 0)
        conversations   (atom {})]
    (endlessly poll-interval
      (println "poll >" @last-timestamp)
      ; Get and split new votes
      (let [new-votes (cm/poll pg-spec @last-timestamp)
            zid-votes (group-by :zid new-votes)]
        ; For each conv... 
        (doseq [[zid votes] zid-votes]
          (let [lastVoteTimestamp (:created (last votes))
                start-time        (System/currentTimeMillis)
                conv              (or (@conversations zid) (new-conv))]
            (swap! conversations
              (fn [convs]
                (try
                  (->> (conv-update conv votes)
                       (assoc convs zid))
                  (catch Exception e
                    (do
                      (cm/log-update-error conv start-time e)
                      ; Put things back the way they were
                      convs)))))

            ; format and upload main results
            (->> (cm/format-conv-for-mongo cm/prep-for-uploading-to-client (@conversations zid) zid lastVoteTimestamp)
              (cm/mongo-upsert-results (cm/mongo-collection-name "main")))

            ; format and upload bidtopid results
            (->> (cm/format-conv-for-mongo cm/prep-for-uploading-bidToPid-mapping (@conversations zid) zid lastVoteTimestamp)
              (cm/mongo-upsert-results (cm/mongo-collection-name "bidtopid")))))

        ; Update last-timestamp, if needed
        (swap! last-timestamp
               (fn [last-ts] (apply max 0 last-ts (map :created new-votes))))))))


