(ns polismath.conv-man
  (:require [polismath.queued-agent :as qa]
            [polismath.conversation :as conv]
            [polismath.metrics :as met]
            [polismath.utils :refer :all]
            [clojure.core.matrix.impl.ndarray]
            [environ.core :as env]
            [monger.core :as mc]
            [monger.collection :as mgcol]
            [cheshire.core :as ch]
            [cheshire.generate :refer [add-encoder encode-seq remove-encoder]]
            [korma.db :as kdb]
            [korma.core :as ko]))


(add-encoder mikera.vectorz.Vector
             (fn [v jsonGenerator]
               (encode-seq (into-array v) jsonGenerator)))

; CAREFUL - make sure we don't lose dimensions of the N-Dimensional array.
(add-encoder clojure.core.matrix.impl.ndarray.NDArray
             (fn [v jsonGenerator]
               (encode-seq (into-array v) jsonGenerator)))


(def metric (met/make-metric-sender "carbon.hostedgraphite.com" 2003 (env/env :hostedgraphite-apikey)))


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


(defn mongo-collection-name [basename]
  (let [schema-date "2014_08_22"
        env-name    (or (env/env :math-env) "dev")]
    (str "math_" env-name "_" schema-date "_" basename)))


(defn mongo-connect! [mongo-url]
  (mc/connect-via-uri! mongo-url))


(defn get-or-set!
  "Either gets the key state of a collection atom, or sets it to a val"
  [coll-atom key & [init-fn]]
  (or (get @coll-atom key)
      (do
        (swap! coll-atom assoc key (init-fn))
        (get-or-set! coll-atom key))))


(defn new-conv-agent-builder [update-fn]
  (fn []
    (qa/queued-agent
      :update-fn update-fn
      :init-fn conv/new-conv)))


(defn prep-for-uploading-bidToPid-mapping [results]
  {"bidToPid" (:bid-to-pid results)})


(defn- assoc-in-bc
  "Helper function to clean up the prep-for-uploading fn"
  [conv k v & kvs]
  (let [this-part (assoc-in conv [:base-clusters k] v)]
    (if (empty? kvs)
      this-part
      (apply assoc-in-bc this-part kvs))))


(defn prep-for-uploading-to-client [results]
  (let [base-clusters (:base-clusters results)]
    (-> results
      ; REFORMAT BASE CLUSTERS
      (dissoc :base-clusters)
      (assoc-in-bc
        "x"       (map #(first (:center %)) base-clusters)
        "y"       (map #(second (:center %)) base-clusters)
        "id"      (map :id base-clusters)
        "members" (map :members base-clusters)
        "count"   (map #(count (:members %)) base-clusters))
      ; Whitelist of keys to be included in sent data; removes intermediates
      (hash-map-subset #{
        :base-clusters
        :group-clusters
        :in-conv
        :lastVoteTimestamp
        :n
        :n-cmts
        :pca
        :repness
        :sid
        :user-vote-counts
        :votes-base}))))


(defn format-conv-for-mongo [prep-fn conv zid lastVoteTimestamp]
  (-> conv
    prep-fn
    ; core.matrix & monger workaround: convert to str with cheshire then back
    ch/generate-string
    ch/parse-string
    (assoc
      "zid" zid
      "lastVoteTimestamp" lastVoteTimestamp)))


(defn mongo-upsert-results [collection-name new-results]
  (monger.collection/update collection-name
    {:zid (:zid new-results)} 
    new-results
    :multi false
    :upsert true))


(defn update-fn-builder [zid]
  (fn [conv values]
    (let [votes (flatten (map :reactions values))
          last-timestamp (apply max (map :last-timestamp values))
          new-conv (conv/conv-update conv votes)]
      ; Format and upload main results
      (->> (format-conv-for-mongo prep-for-uploading-to-client new-conv zid last-timestamp)
        (mongo-upsert-results (mongo-collection-name "main")))
      ; format and upload bidtopid results
      (->> (format-conv-for-mongo prep-for-uploading-bidToPid-mapping new-conv zid last-timestamp)
        (mongo-upsert-results (mongo-collection-name "bidtopid")))
      ; Return the updated conv
      new-conv)))


(defn log-update-error [conv start-time e]
  (println "exception when processing zid: " (:zid conv))
  (.printStackTrace e)
  (let [end (System/currentTimeMillis)
        duration (- end start-time)]
    (metric "math.pca.compute.fail" duration)))


(defn poll [db-spec last-timestamp]
  (try
    (kdb/with-db db-spec
      (ko/select "votes"
        (ko/where {:created [> last-timestamp]})
        (ko/order [:zid :tid :pid :created] :asc))) ; ordering by tid is important, since we rely on this ordering to determine the index within the comps, which needs to correspond to the tid
    (catch Exception e (do
        (println (str "polling failed " (.getMessage e)))
        []))))


