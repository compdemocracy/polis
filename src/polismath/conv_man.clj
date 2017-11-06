;; Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.conv-man
  "This is the namesascpe for the "
  (:require [polismath.math.named-matrix :as nm]
            [polismath.math.conversation :as conv]
            [polismath.math.clusters :as clust]
            [polismath.meta.metrics :as met]
            [polismath.components.env :as env]
            [polismath.components.postgres :as db]
            [polismath.math.corr :as corr]
            [polismath.utils :as utils]
            [clojure.core.matrix.impl.ndarray]
            [clojure.core.async :as async :refer [go go-loop <! >! <!! >!! alts!! alts! chan dropping-buffer put! take!]]
            [taoensso.timbre :as log]
            [com.stuartsierra.component :as component]
            [plumbing.core :as pc]
            [schema.core :as s]
            [polismath.components.postgres :as postgres]))
            


(defn prep-bidToPid
  "Prep function for passing to db/format-as-json-for-db given bidToPid data"
  [results]
  {:zid (:zid results)
   :bidToPid (:bid-to-pid results)
   :lastVoteTimestamp (:last-vote-timestamp results)})


(defn prep-main
  "Prep function for passing to db/format-as-json-for-db and on the main polismath collection."
  [results]
  (-> results
      ; REFORMAT BASE CLUSTERS
      (update-in [:base-clusters] clust/fold-clusters)
      ; Whitelist of keys to be included in sent data; removes intermediates
      (assoc :lastVoteTimestamp (:last-vote-timestamp results))
      (assoc :lastModTimestamp (:last-mod-timestamp results))
      (utils/hash-map-subset #{:base-clusters
                               :group-clusters
                               :subgroup-clusters
                               :in-conv
                               :mod-out
                               :lastVoteTimestamp
                               :lastModTimestamp
                               :n
                               :n-cmts
                               :pca
                               :repness
                               :consensus
                               :zid
                               :tids
                               :user-vote-counts
                               :votes-base
                               :group-votes
                               :subgroup-votes
                               :subgroup-repness})))
                               ;:subgroup-ptpt-stats})))


(defn columnize
  ([stats keys]
   (->> keys
        (map
          (fn [k]
            (let [vals (map (fn [stat] (get stat k)) stats)]
              [k vals])))
        (into {})))
  ([stats]
   (let [keys (-> stats first keys)]
     (columnize stats keys))))

(defn prep-ptpt-stats
  [results]
  {:zid (:zid results)
   :ptptstats (columnize (:ptpt-stats results))
   :lastVoteTimestamp (:last-vote-timestamp results)})


(defn handle-profile-data
  "For now, just log profile data. Eventually want to send to influxDB and graphite."
  [{:as conv-man :keys [postgres config]} conv & {:keys [recompute n-votes finish-time] :as extra-data}]
  (if-let [prof-atom (:profile-data conv)]
    (let [prof @prof-atom
          tot (apply + (map second prof))
          prof (assoc prof :total tot)]
      (try
        (-> prof
            (assoc :n-ptps (:n conv))
            (merge (utils/hash-map-subset conv #{:n-cmts :zid :last-vote-timestamp})
                   extra-data)
            (->> (db/upload-math-profile postgres (:zid conv))))
        (catch Exception e
          (log/warn "Unable to submit profile data for zid:" (:zid conv))
          (.printStackTrace e)))
      (log/debug "Profile data for zid" (:zid conv) ": " prof))))

;; XXX This is temporary; should be switching to schema work in conversation ns
;; Also, should place this in conversation, but for now...
(def Conversation
  "A schema for what valid conversations should look like (WIP)"
  {:zid                 s/Int
   :last-vote-timestamp s/Int
   :group-votes         s/Any
   ;; Note: we let all other key-value pairs pass through
   s/Keyword            s/Any})

;; Should rename this not to conflict with clojure.core/update... poor form
(defn conv-update
  "This function is what actually gets sent to the conv-manager. In addition to the conversation and vote batches
  up in the channel, we also take an error-callback. Eventually we'll want to pass opts through here as well."
  [conv-man conv votes error-callback]
  (let [start-time (System/currentTimeMillis)
        config (:config conv-man)
        pg (:postgres conv-man)]
    (log/info "Starting conversation update for zid:" (:zid conv))
    (try
      ;; Need to expose opts for conv-update through config... XXX
      (let [updated-conv   (conv/conv-update conv votes)
            zid            (:zid updated-conv)
            finish-time    (System/currentTimeMillis)
            ; If this is a recompute, we'll have either :full or :reboot, ow/ want to send false
            recompute      (if-let [rc (:recompute conv)] rc false)]
        (log/info "Finished computng conv-update for zid" zid "in" (- finish-time start-time) "ms")
        (handle-profile-data conv-man
                             updated-conv
                             :finish-time finish-time
                             :recompute recompute
                             :n-votes (count votes))
        ;; Make sure our data has the right shape
        (when-let [validation-errors (s/check Conversation updated-conv)]
          ;; XXX Should really be using throw+ (slingshot) here and throutout the code base
          ;; Also, should put in code for doing smart collapsing of collections...
          (log/error "Validation error: Conversation value does not match schema for conv:" updated-conv)
          (throw (Exception. (str "Validation error: Conversation Value does not match schema: "
                                  validation-errors))))
        ; Return the updated conv
        updated-conv)
      ; In case anything happens, run the error-callback handler. Agent error handlers do not work here, since
      ; they don't give us access to the votes.
      (catch Exception e
        ;; XXX See comment below about decoupling errors
        (error-callback votes start-time (:opts' conv) e)
        conv))))

(defn write-conv-updates!
  [{:as conv-man :keys [postgres]} {:as updated-conv :keys [zid]} math-tick]
  ;; TODO Really need to extract these writes so that mod updates do whta they're supposed to! And also run in async/thread for better parallelism
  ; Format and upload main results
  (async/thread
    (doseq [[prep-fn uploader] [[prep-main db/upload-math-main] ; main math results, for client
                                [prep-bidToPid db/upload-math-bidtopid] ; bidtopid mapping, for server
                                [prep-ptpt-stats db/upload-math-ptptstats]]]
      (->> updated-conv
           prep-fn
           (uploader postgres zid math-tick)))
    (log/info "Finished uploading math results for zid:" zid)))

;; Maybe switch over to using this with arbitrary attrs map with zid and other data? XXX
;(defmacro try-with-error-log
  ;[zid message & body]
  ;`(try
     ;~@body
     ;(catch
       ;(log/error ~message (str "(for zid=" ~zid ")")))))


;; ### Side notes on error handling

;; Should be decoupling error handling from all of this mess; create it's own logic shoot and perhaps
;; component so we can look at inspect and reason about the error flow of the system.
;; Make it programatic; pure; not just a ad-hoc try/catch flow control thing coupled with the logic of the
;; application.

(defn build-update-error-handler
  "Returns a closure that can be called in case there is an update error. The closure gives access to
  the queue so votes can be requeued"
  [conv-man queue conv]
  (fn [votes start-time opts update-error]
    (let [zid-str (str "zid=" (:zid conv))]
      (log/error "Failed conversation update for" zid-str)
      (.printStackTrace update-error)
      ; Try requeing the votes that failed so that if we get more, they'll get replayed
      ; XXX - this could lead to a recast vote being ignored, so maybe the sort should just always happen in
      ; the conv-actor update?
      (try
        (log/info "Preparing to re-queue votes for failed conversation update for" zid-str)
        ;; XXX Should we check if the queue got close due to error or manager close, and log?
        (async/go (async/>! queue {:message-type :votes :message-batch votes}))
        (catch Exception qe
          (log/error "Unable to re-queue votes after conversation update failed for" zid-str)
          (.printStackTrace qe)))
      ; Try to send some failed conversation time metrics, but don't stress if it fails
      (try
        (let [end (System/currentTimeMillis)
              duration (- end start-time)]
          ;; Update to use MetricSender component XXX
          (met/send-metric (:metrics conv-man) "math.pca.compute.fail" duration))
        (catch Exception e
          (log/error "Unable to send metrics for failed compute for" zid-str)))
      ; Try to save conversation state for debugging purposes
      (try
        (conv/conv-update-dump conv votes opts update-error)
        (catch Exception e
          (log/error "Unable to perform conv-update dump for" zid-str))))))


;; XXX This is really bad, now that I think of it. There should be a data-driven declarative specification of
;; what the shape of a conversation is, what is required, what needs to be modified etc, so everything is all
;; in one place. This problem with teh :lastVoteTimestamp and group-votes etc came up precisely because there
;; wasn't "one place to go" for modifying all of the potential points of interest for these kind of changes.

;; ^ I'm leaving this note in for posterity, but note that this is exactly what spec is :-)

;; XXX However, we shouldn't even be pushing the results if we didn't actually update anything

(defn restructure-json-conv
  [conv]
  (-> conv
      (utils/hash-map-subset #{:math_tick :raw-rating-mat :rating-mat :lastVoteTimestamp :mod-out :zid :pca :in-conv :n :n-cmts :group-clusters :base-clusters :repness :group-votes :subgroup-clusters :subgroup-votes :subgroup-repness})
      (assoc :last-vote-timestamp (get conv :lastVoteTimestamp)
             :last-mod-timestamp  (get conv :lastModTimestamp))
      ; Make sure there is an empty named matrix to operate on
      (assoc :raw-rating-mat (nm/named-matrix))
      ; Update the base clusters to be unfolded
      (update :base-clusters clust/unfold-clusters)
      ; Make sure in-conv is a set
      (update :in-conv set)
      (update :mod-out set)))


(defn load-or-init
  "Given a zid, either load a minimal set of information from postgres, or if a new zid, create a new conv"
  [conv-man zid & {:keys [recompute]}]
  ;; TODO On recompute should try to preserve in conv and such
  (log/info "Running load or init")
  (if-let [conv (and (not recompute) (db/load-conv (:postgres conv-man) zid))]
    (-> conv
        ;(->> (tr/trace "load-or-init (about to restructure):"))
        restructure-json-conv
        ;(->> (tr/trace "load-or-init (post restructure):"))
        ;; What the fuck is this all about? Should this really be getting set here?
        (assoc :recompute :reboot)
        (assoc :raw-rating-mat
               (-> (nm/named-matrix)
                   (nm/update-nmat (->> (db/conv-poll (:postgres conv-man) zid 0)
                                        (map (fn [vote-row] (mapv (partial get vote-row) [:pid :tid :vote])))))))
        (conv/mod-update
          (db/conv-mod-poll (:postgres conv-man) zid 0)))
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


(defn split-batches
  "This function splits message batches as sent to conv actor up by the first item in batch vector (:votes :moderation)
  so messages can get processed properly"
  [messages]
  (->> messages
       (group-by :message-type)
       (pc/map-vals
         (fn [labeled-batches]
           (->> labeled-batches
                (map :message-batch)
                (flatten))))))


(defrecord ConversationManager [config postgres metrics conversations listeners kill-chan]
  component/Lifecycle
  (start [component]
    (log/info ">> Starting ConversationManager")
    (let [conversations (atom {})
          listeners (atom {})
          kill-chan (async/promise-chan)]
      (assoc component :conversations conversations :listeners listeners :kill-chan kill-chan)))
  (stop [component]
    (log/info "<< Stopping ConversationManager")
    (try
      ;; Close all our message channels for good measure
      (log/debug "conversations:" conversations)
      (go (>! kill-chan :kill))
      (doseq [[zid {:keys [message-chan]}] @conversations]
        (async/close! message-chan))
      ;; Not sure, but we might want this for GC
      (reset! conversations nil)
      (reset! listeners nil)
      (catch Exception e
        (log/error e "Unable to stop ConvMan component")))
    component))

(defn create-conversation-manager
  []
  (map->ConversationManager {}))

(defn add-listener!
  ([conv-man listener-fn]
   (add-listener! conv-man (rand-int 9999999) listener-fn))
  ([{:as conv-man :keys [listeners]} listener-key listener-fn]
   (swap! listeners assoc listener-key listener-fn)))


(defn generate-report-data!
  [{:as conv-man :keys [postgres]} conv math-tick report-data]
  (log/info "Generating report data for report:" report-data)
  (let [rid (:rid report-data)
        tids (map :tid (postgres/query (:postgres conv-man) (postgres/report-tids rid)))
        corr-mat (corr/compute-corr conv tids)]
    (async/thread
      (postgres/insert-correlationmatrix! postgres rid math-tick corr-mat)
      ;; TODO update to submit usng task type and task bucket
      (postgres/mark-task-complete! postgres "generate_report_data" rid))))


(defn conv-actor
  [{:as conv-man :keys [conversations kill-chan config listeners]} zid]
  (log/info "Starting message batch queue and handler routine for conv zid:" zid)
  (let [conv (load-or-init conv-man zid :recompute (:recompute config))
        _ (log/info "Conversation loaded for conv zid:" zid)
        ;; Set up our main message chan
        message-chan (chan 10000)
        ;; Separate channel for messages that we've tried to process but that haven't worked for one reason or another (buffer size not important here)
        retry-chan   (chan 10)]
    (go-loop [conv conv]
      ;; If nil comes through as the first message, then the chan is closed, and we should be done, not continue looping forever
      (when-not (async/poll! kill-chan)
        (when-let [first-msg (<! message-chan)]
          ;; If there are any retry messages from a failed recompute, we put them at the front of the message stack.
          ;; But retry messages only get processed in this way if there are new messages that have come in triggering the
          ;; first-msg take above, ensuring we don't just loop forever on a broken message/update.
          (log/info "Message chan put in queue-message-batch! for zid:" zid)
          (let [retry-msgs (async/poll! retry-chan)
                msgs (vec (concat retry-msgs [first-msg] (take-all! message-chan)))
                ;; Regardless, now we split the messages by message type and process them as below
                {:as split-msgs :keys [votes moderation generate_report_data]} (split-batches msgs)
                ;; Here we construct an error handler that gets passed to the conv update process, wrapping the retry queue,
                ;; error reporting, etc.
                error-handler (build-update-error-handler conv-man retry-chan conv)
                ;; Run moderation and vote updates
                conv (if moderation
                       (conv/mod-update conv moderation)
                       conv)
                ;; Note that we run the update here if there are either new votes or changes in moderation; conv update
                ;; should work on nil vote seq; we also run if we get a report gen request but haven't built the reating mat
                conv (if (or moderation votes (not (:rating-mat conv)))
                       (conv-update conv-man conv votes error-handler)
                       conv)
                math-tick (postgres/inc-math-tick (:postgres conv-man) zid)]
            (log/info "Completed computing conversation zid:" zid)
            (log/debug "Mod out for zid" zid "is:" (:mod-out conv))
            (write-conv-updates! conv-man conv math-tick)
            ;; Run reports corr matrix stuff (etc)
            (doseq [report-task generate_report_data]
              (generate-report-data! conv-man conv math-tick report-task))
            ;; Here, we assoc into the parent conversations state as a convenience; the actual "current state" is
            ;; as closed over in this go-loop.
            (swap! conversations assoc-in [zid :conv] conv)
            (async/thread
              (doseq [[k f] @listeners] (try (f conv) (catch Exception e (log/error e "Listener error")))))
            (recur conv)))))
    {:conv conv :message-chan message-chan :retry-chan retry-chan}))


;; Need to think about what to do if failed conversations lead to messages piling up in the message queue XXX
(defn queue-message-batch!
  "Queue message batches for a given conversation by zid"
  [{:as conv-man :keys [conversations config listeners kill-chan]} message-type zid message-batch]
  (when-not (async/poll! kill-chan)
    (if-let [{:keys [conv message-chan]} (get @conversations zid)]
      ;; Then we already have a go loop running for this
      (>!! message-chan {:message-type message-type :message-batch message-batch})
      ;; Then we need to initialize the conversation and set up the conversation channel and go routine
      (let [conv-actor (conv-actor conv-man zid)]
        (swap! conversations assoc zid conv-actor)
        ;; Just call again to make sure the message gets on the chan (using the if-let fork above) :-)
        (queue-message-batch! conv-man message-type zid message-batch)))))


;; Need to find a good way of making sure these tests don't ever get committed uncommented
(comment
  (require '[clojure.test :as test])
  (test/run-tests 'conv-man-tests))


:ok

