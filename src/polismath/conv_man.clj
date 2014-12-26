(ns polismath.conv-man
  (:require [polismath.named-matrix :as nm]
            [polismath.conversation :as conv]
            [polismath.metrics :as met]
            [polismath.db :as db]
            [polismath.utils :refer :all]
            [plumbing.core :as pc]
            [clojure.core.matrix.impl.ndarray]
            [clojure.core.async
             :as as
             :refer [go go-loop <! >! <!! >!! alts!! alts! chan dropping-buffer
                     put! take!]]
            [clojure.tools.trace :as tr]
            [polismath.env :as env]
            [monger.core :as mg]
            [monger.collection :as mc]
            [cheshire.core :as ch]
            [cheshire.generate :refer [add-encoder encode-seq remove-encoder]]
            [clojure.tools.logging :as log]))

(when-not (#{"prod" "production" "preprod"} (env/env :math-env))
  (use 'alex-and-georges.debug-repl))


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
  {:zid (:zid results)
   :bidToPid (:bid-to-pid results)
   :lastVoteTimestamp (:last-vote-timestamp results)})


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
      (assoc :lastVoteTimestamp (:last-vote-timestamp results))
      (hash-map-subset #{
        :base-clusters
        :group-clusters
        :in-conv
        :lastVoteTimestamp
        :n
        :n-cmts
        :pca
        :repness
        :consensus
        :zid
        :user-vote-counts
        :votes-base}))))


(defn format-for-mongo
  "Formats data for mongo, first passing through a prep function which may strip out uneeded junk or
  reshape things. Takes conv and lastVoteTimestamp, though the latter may be moved into the former in update"
  [prep-fn conv]
  (-> conv
    prep-fn
    ; core.matrix & monger workaround: convert to str with cheshire then back
    ch/generate-string
    ch/parse-string))


(defn mongo-upsert-results
  "Perform upsert of new results on mongo collection name"
  [collection-name new-results]
  (mc/update
    ; Bleg; not the cleanest separation here; should at least try to make this something rebindable
    (db/mongo-db (env/env :mongolab-uri))
    collection-name
    {:zid (or (:zid new-results) ; covering our bases for strings or keywords due to cheshire hack
              (get new-results "zid"))}
    new-results
    {:upsert true}))


(defn handle-profile-data
  "For now, just log profile data. Eventually want to send to influxDB and graphite."
  [conv]
  (let [prof @(:profile-data conv)
        tot  (apply + (map second prof))]
    (log/debug "Profile data for zid" (:zid conv) ": " prof)))


(defn update-fn
  "This function is what actually gets sent to the conv-actor. In addition to the conversation and vote batches
  up in the channel, we also take an error-callback. Eventually we'll want to pass opts through here as well."
  [conv votes error-callback]
  (let [start-time (System/currentTimeMillis)]
    (try
      (let [updated-conv   (conv/conv-update conv votes)
            zid            (:zid updated-conv)
            finish-time    (System/currentTimeMillis)]
        (log/info "Finished computng conv-update for zid" zid "in" (- finish-time start-time) "ms")
        (handle-profile-data updated-conv)
        ; Format and upload main results
        (doseq [[col-name prep-fn] [["main" prep-main] ; main math results, for client
                                    ["bidtopid" prep-bidToPid]]] ; bidtopid mapping, for server
          (->> (format-for-mongo prep-fn updated-conv)
               (mongo-upsert-results (db/mongo-collection-name col-name))))
        (log/info "Finished uploading mongo results for zid" zid)
        ; Return the updated conv
        updated-conv)
      ; In case anything happens, run the error-callback handler. Agent error handlers do not work here, since
      ; they don't give us access to the votes.
      (catch Exception e
        (error-callback votes start-time (:opts' conv) e)
        ; Wait a second before returning the origin, unmodified conv, to throttle retries
        (Thread/sleep 1000)
        conv))))


;(defmacro try-with-error-log
  ;[zid message & body]
  ;`(try
     ;~@body
     ;(catch
       ;(log/error ~message (str "(for zid=" ~zid ")")))))


(defn build-update-error-handler
  "Returns a clojure that can be called in case there is an update error. The closure gives access to
  the queue so votes can be requeued"
  [queue conv-actor]
  (fn [votes start-time opts update-error]
    (let [zid-str (str "zid=" (:zid @conv-actor))]
      (log/error "Failed conversation update for" zid-str)
      (.printStackTrace update-error)
      ; Try requeing the votes that failed so that if we get more, they'll get replayed
      ; XXX - this could lead to a recast vote being ignored, so maybe the sort should just always happen in
      ; the conv-actor update?
      (try
        (log/info "Preparing to re-queue votes for failed conversation update for" zid-str)
        (as/go (as/>! queue [:votes votes]))
        (catch Exception qe
          (log/error "Unable to re-queue votes after conversation update failed for" zid-str)
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
        (conv/conv-update-dump @conv-actor votes opts update-error)
        (catch Exception e
          (log/error "Unable to perform conv-update dump for" zid-str))))))


(defn load-or-init
  "Given a zid, either load a minimal set of information from mongo, or if a new zid, create a new conv"
  [zid & {:keys [recompute]}]
  (if-let [conv (and (not recompute) (db/load-conv zid))]
    (-> conv
        (hash-map-subset #{:rating-mat :lastVoteTimestamp :zid :pca :in-conv :n :n-cmts})
        ; Make sure there is an empty named matrix to operate on
        (assoc :rating-mat (nm/named-matrix))
        ; Make sure in-conv is a set
        (update-in [:in-conv] set))
    (assoc (conv/new-conv) :zid zid)))


(defmacro take-all! [c]
  "Given a channel, takes all values currently in channel and places in a vector. Must be called
  within a go block."
  `(loop [acc# []]
     (let [[v# ~c] (alts! [~c] :default nil)]
       (if (not= ~c :default)
         (recur (conj acc# v#))
         acc#))))


(defn take-all!! [c]
  "Given a channel, takes all values currently in channel and places in a vector. Must be called
  within a go block."
  (loop [acc []]
    (let [[v c] (alts!! [c] :default nil)]
      (if (not= c :default)
        (recur (conj acc v))
        acc))))


(defprotocol IEagerActor
  (snd [this votes]))


(defrecord ConvActor [msgbox conv]
  IEagerActor
  (snd [_ votes]
    (>!! msgbox votes))
  clojure.lang.IRef
  (deref [_]
    @conv))


(defn add-conv-actor-watch
  [conv-actor key f]
  (add-watch (:conv conv-actor) key f))


(defn split-batches
  [messages]
  (->> messages
       (group-by first)
       (pc/map-vals
         (fn [labeled-batches]
           (->> labeled-batches
                (map second)
                (flatten))))))


(defn new-conv-actor [init-fn & opts]
  (let [msgbox (chan Long/MAX_VALUE) ; we want this to be as big as possible, since backpressure doesn't really work
        conv (atom (init-fn)) ; keep track of conv state in atom so it can be dereffed
        ca (ConvActor. msgbox conv)
        err-handler (build-update-error-handler msgbox ca)]
    ; Initialize the go loop which watches the mailbox, and runs updates all all pending messages when they
    ; arrive
    (go-loop []
      (try
        (let [first-msg (<! msgbox) ; do this so we park efficiently
              msgs      (take-all! msgbox)
              msgs      (concat [first-msg] msgs)
              {votes :votes mods :moderation}
                        (split-batches msgs)]
          (when mods
            (swap! conv/mod-update mods))
          (when votes
            (swap! conv update-fn (or votes []) err-handler)))
        (catch Exception e
          (log/error "Excpetion not handler by err-handler:" e)
          (.printStackTrace e)))
      (recur))
    ca))


