(ns polismath.conv-man
  (:require [polismath.named-matrix :as nm]
            [polismath.conversation :as conv]
            [polismath.clusters :as clust]
            [polismath.metrics :as met]
            [polismath.db :as db]
            [polismath.utils :refer :all]
            [plumbing.core :as pc]
            [schema.core :as s]
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
  "Prep function for passing to db/format-for-mongo given bidToPid data"
  [results]
  {:zid (:zid results)
   :bidToPid (:bid-to-pid results)
   :lastVoteTimestamp (:last-vote-timestamp results)})


(defn prep-main
  "Prep function for passing to db/format-for-mongo and on the main polismath collection."
  [results]
  (-> results
      ; REFORMAT BASE CLUSTERS
      (update-in [:base-clusters] clust/fold-clusters)
      ; Whitelist of keys to be included in sent data; removes intermediates
      (assoc :lastVoteTimestamp (:last-vote-timestamp results))
      (assoc :lastModTimestamp (:last-mod-timestamp results))
      (hash-map-subset #{
                         :base-clusters
                         :group-clusters
                         :in-conv
                         :lastVoteTimestamp
                         :lastModTimestamp
                         :n
                         :n-cmts
                         :pca
                         :repness
                         :consensus
                         :zid
                         :user-vote-counts
                         :votes-base
                         :group-votes})))


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


(defn mongo-insert-results
  "Perform insert to mongo collection by zid"
  [collection-name object]
  (mc/insert
    (db/mongo-db (env/env :mongolab-uri))
    collection-name
    object))


(defn handle-profile-data
  "For now, just log profile data. Eventually want to send to influxDB and graphite."
  [conv & {:keys [recompute n-votes finish-time] :as extra-data}]
  (if-let [prof-atom (:profile-data conv)]
    (let [prof @prof-atom
          tot (apply + (map second prof))
          prof (assoc prof :total tot)]
      (try
        (-> prof
            (assoc :n-ptps (:n conv))
            (merge (hash-map-subset conv #{:n-cmts :zid :last-vote-timestamp})
                   extra-data)
            ((partial mongo-insert-results (db/mongo-collection-name "profile"))))
        (catch Exception e
          (log/warn "Unable to submit profile data for zid:" (:zid conv))
          (.printStackTrace e)))
      (log/debug "Profile data for zid" (:zid conv) ": " prof))))

;; XXX WIP; need to flesh out and think about all the ins and outs
;; Also, should place this in conversation, but for now...
(def Conversation
  "A schema for what valid conversations should look like (WIP)"
  {:zid                 s/Int
   :last-vote-timestamp s/Int
   :group-votes         s/Any
   ;; Note: we let all other key-value pairs pass through
   s/Keyword            s/Any})

(defn update-fn
  "This function is what actually gets sent to the conv-actor. In addition to the conversation and vote batches
  up in the channel, we also take an error-callback. Eventually we'll want to pass opts through here as well."
  [conv votes error-callback]
  (let [start-time (System/currentTimeMillis)]
    (log/info "Starting conversation update for zid:" (:zid conv))
    (try
      (let [updated-conv   (conv/conv-update conv votes)
            zid            (:zid updated-conv)
            finish-time    (System/currentTimeMillis)
            ; If this is a recompute, we'll have either :full or :reboot, ow/ want to send false
            recompute      (if-let [rc (:recompute conv)] rc false)]
        (log/info "Finished computng conv-update for zid" zid "in" (- finish-time start-time) "ms")
        (handle-profile-data updated-conv
                             :finish-time finish-time
                             :recompute recompute
                             :n-votes (count votes))
        ;; Make sure our data has the right shape
        (when-let [validation-errors (s/check Conversation updated-conv)]
          ;; XXX Should really be using throw+ (slingshot) here and throutout the code base
          ;; Also, should put in code for doing smart collapsing of collections...
          (throw (Exception. (str "Validation error: Conversation Value does not match schema: "
                                  validation-errors))))
        ; Format and upload main results
        (doseq [[col-name prep-fn] [["main" prep-main] ; main math results, for client
                                    ["bidtopid" prep-bidToPid]]] ; bidtopid mapping, for server
          (->> (db/format-for-mongo prep-fn updated-conv)
               (mongo-upsert-results (db/mongo-collection-name col-name))))
        (log/info "Finished uploading mongo results for zid" zid)
        ; Return the updated conv
        updated-conv)
      ; In case anything happens, run the error-callback handler. Agent error handlers do not work here, since
      ; they don't give us access to the votes.
      (catch Exception e
        (error-callback votes start-time (:opts' conv) e)
        ; Wait a second before returning the origin, unmodified conv, to throttle retries
        ;; XXX This shouldn't be here... ???
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


;; XXX This is really bad, now that I think of it. There should be a data-driven declarative specification of
;; what the sape of a conversation is, what is required, what needs to be modified etc, so everything is all
;; in one place. This problem with teh :lastVoteTimestamp and group-votes etc came up precisely because there
;; wasn't "one place to go" for modifying all of the potential points of interest for these kind of changes.

;; XXX However, we shouldn't even be pushing the results to mongo if we didn't actually update anything

(defn restructure-mongo-conv
  [conv]
  (-> conv
      (hash-map-subset #{:rating-mat :lastVoteTimestamp :zid :pca :in-conv :n :n-cmts :group-clusters :base-clusters :group-votes})
      (assoc :last-vote-timestamp (get conv :lastVoteTimestamp)
             :last-mod-timestamp  (get conv :lastModTimestamp))
      ; Make sure there is an empty named matrix to operate on
      (assoc :rating-mat (nm/named-matrix))
      ; Update the base clusters to be unfolded
      (update-in [:base-clusters] clust/unfold-clusters)
      ; Make sure in-conv is a set
      (update-in [:in-conv] set)))


(defn load-or-init
  "Given a zid, either load a minimal set of information from mongo, or if a new zid, create a new conv"
  [zid & {:keys [recompute]}]
  (if-let [conv (and (not recompute) (db/load-conv zid))]
    (-> conv
        restructure-mongo-conv
        (assoc :recompute :reboot)
        (assoc :rating-mat (-> (nm/named-matrix)
                               (nm/update-nmat (->> (db/conv-poll zid 0)
                                                    (map (fn [vote-row] (mapv (partial get vote-row) [:pid :tid :vote]))))))))
    ; would be nice to have :recompute :initial
    (assoc (conv/new-conv) :zid zid :recompute :full)))


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


(defprotocol PActor
  (snd [this votes]))


(defrecord ConvActor [msgbox conv]
  PActor
  (snd [_ votes]
    (>!! msgbox votes))
  clojure.lang.IRef
  (deref [_]
    @conv))


(defn add-conv-actor-watch
  "Add a watcher to the atom holding state in a conv-actor"
  [conv-actor key f]
  (add-watch (:conv conv-actor) key f))


(defn split-batches
  "This function splits message batches as sent to conv actor up by the first item in batch vector (:votes :moderation)
  so messages can get processed properly"
  [messages]
  (->> messages
       (group-by first)
       (pc/map-vals
         (fn [labeled-batches]
           (->> labeled-batches
                (map second)
                (flatten))))))


(defn new-conv-actor [init-fn & opts]
  "Create a new conv actor which responds to snd. Messages should look like [<t> [...]], where <t> is either :votes or
  :moderation, depending on what kind of batch is being sent/processed. Implements deref for state retrieval."
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
            (swap! conv conv/mod-update mods))
          (swap! conv update-fn (or votes []) err-handler))
        (catch Exception e
          (log/error "Excpetion not handler by err-handler:" e)
          (.printStackTrace e)))
      (recur))
    ca))


