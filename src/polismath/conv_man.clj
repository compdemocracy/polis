(ns polismath.conv-man
  (:require [polismath.queued-agent :as qa]
            [polismath.conversation :as conv]
            [polismath.metrics :as met]
            [polismath.utils :refer :all]
            [clojure.core.matrix.impl.ndarray]
            [clojure.core.async :as as]
            [environ.core :as env]
            [monger.core :as mc]
            [monger.collection :as mgcol]
            [cheshire.core :as ch]
            [cheshire.generate :refer [add-encoder encode-seq remove-encoder]]
            [clojure.tools.logging :as log]))


(add-encoder mikera.vectorz.Vector
             (fn [v jsonGenerator]
               (encode-seq (into-array v) jsonGenerator)))

; CAREFUL - make sure we don't lose dimensions of the N-Dimensional array.
(add-encoder clojure.core.matrix.impl.ndarray.NDArray
             (fn [v jsonGenerator]
               (encode-seq (into-array v) jsonGenerator)))


; Create graphite sender
(def metric (met/make-metric-sender "carbon.hostedgraphite.com" 2003 (env/env :hostedgraphite-apikey)))


(defmacro meter
  "Send performance metrics to graphite"
  [metric-name & expr]
  `(let [start# (System/currentTimeMillis)
         ret# ~@expr
         end# (System/currentTimeMillis)
         duration# (- end# start#)]
     (metric ~metric-name duration# end#)
     (log/debug (str end# " " ~metric-name " " duration# " millis"))
     ret#))


(defn mongo-collection-name
  "Mongo collection name based on MATH_ENV env variable and hard-coded schema data. Makes sure that
  prod, preprod, dev (and subdevs like chrisdev) have their own noninterfering collections."
  [basename]
  (let [schema-date "2014_08_22"
        env-name    (or (env/env :math-env) "dev")]
    (str "math_" env-name "_" schema-date "_" basename)))


(defn mongo-connect!
  "Connect to a mongo database given mongo-url"
  [mongo-url]
  (mc/connect-via-uri! mongo-url))


(defn get-or-set!
  "Either gets the key state of a collection atom, or sets it to a val"
  [coll-atom key & [init-fn]]
  (or (get @coll-atom key)
      (do
        (swap! coll-atom assoc key (init-fn))
        (get-or-set! coll-atom key))))


(defn prep-bidToPid
  "Prep function for passing to format-for-mongo given bidToPid data"
  [results]
  {"bidToPid" (:bid-to-pid results)})


(defn- assoc-in-bc
  "Helper function to clean up the prep-for-uploading fn"
  [conv k v & kvs]
  (let [this-part (assoc-in conv [:base-clusters k] v)]
    (if (empty? kvs)
      this-part
      (apply assoc-in-bc this-part kvs))))


(defn prep-main
  "Prep function for passing to format-for-mongo and on the main polismath collection."
  [results]
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
        :zid
        :user-vote-counts
        :votes-base}))))


(defn format-for-mongo
  "Formats data for mongo, first passing through a prep function which may strip out uneeded junk or
  reshape things. Takes conv and lastVoteTimestamp, though the latter may be moved into the former in update"
  [prep-fn conv lastVoteTimestamp]
  (-> conv
    prep-fn
    ; core.matrix & monger workaround: convert to str with cheshire then back
    ch/generate-string
    ch/parse-string
    (assoc
      "lastVoteTimestamp" lastVoteTimestamp)))


(defn mongo-upsert-results
  "Perform upsert of new results on mongo collection name"
  [collection-name new-results]
  (monger.collection/update collection-name
    {:zid (:zid new-results)} 
    new-results
    :multi false
    :upsert true))


(defn flatten-vote-batches
  "Prep vote batches as the enter from a channel. Extract the actual votes, and flatten into a single coll,
  sorted by :created so that changed votes are appropriately accounted for."
  [vote-batches]
  (sort-by :created (flatten (map :reactions vote-batches))))


(defn update-fn
  "This function is what actually gets sent to the conv-actor. In addition to the conversation and vote batches
  up in the channel, we also take an error-callback. Eventually we'll want to pass opts through here as well."
  [conv vote-batches error-callback]
  (let [start-time (System/currentTimeMillis)]
    (try
      (let [votes          (flatten-vote-batches vote-batches)
            last-timestamp (apply max (map :last-timestamp vote-batches))
            updated-conv   (conv/conv-update conv votes)
            zid            (:zid updated-conv)]
        (log/info "Finished computng conv-update for zid" zid)
        ; Format and upload main results
        (->> (format-for-mongo prep-main updated-conv last-timestamp)
          (mongo-upsert-results (mongo-collection-name "main")))
        ; format and upload bidtopid results
        (->> (format-for-mongo prep-bidToPid updated-conv last-timestamp)
          (mongo-upsert-results (mongo-collection-name "bidtopid")))
        (log/info "Finished uploading mongo results for zid" zid)
        ; Return the updated conv
        updated-conv)
      ; In case anything happens, run the error-callback handler. Agent error handlers do not work here, since
      ; they don't give us access to the votes.
      (catch Exception e
        (error-callback vote-batches (:opts' conv) start-time e)
        ; Wait a second before returning the origin, unmodified conv, to throttle retries
        (Thread/sleep 1000)
        conv))))


(defn build-update-error-handler
  "Returns a clojure that can be called in case there is an update error. The closure gives access to
  the queue so votes can be requeued"
  [queue conv-agent]
  (fn [vote-batches start-time opts update-error]
    (let [zid-str (str "zid=" (:zid @conv-agent))]
      (log/error "Failed conversation update for" zid-str)
      (.printStackTrace update-error)
      ; Try requeing the votes that failed so that if we get more, they'll get replayed
      ; XXX - this could lead to a recast vote being ignored, so maybe the sort should just always happen in
      ; the conv update?
      (try
        (log/info "Preparing to re-queue vote-batches for failed conversation update for" zid-str)
        (doseq [vote-batch vote-batches]
          (as/go (as/>! queue vote-batch)))
        (catch Exception qe
          (log/error "Unable to re-queue vote-batches after conversation update failed for" zid-str)
          (.printStackTrace qe)))
      ; Try to send some failed conversation time metrics, but don't stress if it fails
      (try
        (let [end (System/currentTimeMillis)
              duration (- end start-time)]
          (metric "math.pca.compute.fail" duration))
        (catch Exception e
          (log/error "Unable to send metrics for failed compute for" zid-str)))
      ; Try to save conversation state for debugging purposes
      (try
        (let [votes (flatten-vote-batches vote-batches)]
          (conv/conv-update-dump @conv-agent votes opts update-error))
        (catch Exception e
          (log/error "Unable to perform conv-update dump for" zid-str))))))


(defn new-conv-agent-builder
  "Given an update function, creates a function which returns a queued agent with the given update function.
  This eases some of the flow logic for using the queued agents in the stormspec"
  [update-fn]
  (fn []
    (qa/queued-agent
      :update-fn update-fn
      :init-fn conv/new-conv
      :error-handler-builder build-update-error-handler)))


