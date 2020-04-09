;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.conv-man
  "This is the namesascpe for the "
  (:require [polismath.math.named-matrix :as nm]
            [polismath.math.conversation :as conv]
            [polismath.math.clusters :as clust]
            [polismath.meta.metrics :as met]
            [polismath.meta.notify :as notify]
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



;; Here, we organize things in terms of a conversation manager, which maintains a cache of conversations and routes
;; messages and updates to these conversations.
;; The conversations themselves are organized around conversation actors, which maintain the actual state of the
;; conversation, as well as the message handling machinery (chans and such).
;; Updates to the conversation actors are broken down via a react-to-messages multimethod, which allows for message
;; handling extensibility.


;; Utility update functions
;; ------------------------

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
      ; IMPORTANT! Whitelist of keys to be included in json output; used for removing intermediates
      (assoc :lastVoteTimestamp (:last-vote-timestamp results))
      (assoc :lastModTimestamp (:last-mod-timestamp results))
      (utils/hash-map-subset #{:base-clusters
                               :group-clusters
                               :subgroup-clusters
                               :in-conv
                               :mod-out
                               :mod-in
                               :meta-tids
                               :lastVoteTimestamp
                               :lastModTimestamp
                               :n
                               :n-cmts
                               :pca
                               :repness
                               :group-aware-consensus
                               :consensus
                               :zid
                               :tids
                               :user-vote-counts
                               :votes-base
                               :group-votes
                               :subgroup-votes
                               :subgroup-repness
                               :comment-priorities})))
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



;; Conversation update functions
;; =============================

;; XXX This is temporary; should be switching to new spec work in conversation ns
(def Conversation
  "A schema for what valid conversations should look like (WIP)"
  {:zid                 s/Int
   ;; Note: we let all other key-value pairs pass through
   s/Keyword            s/Any})

;; Should rename this not to conflict with clojure.core/update... poor form
(defn conv-update
  "This function is what actually gets sent to the conv-manager. In addition to the conversation and vote batches
  up in the channel, we also take an error-callback. Eventually we'll want to pass opts through here as well."
  [conv-man conv votes]
  (let [start-time (System/currentTimeMillis)
        config (:config conv-man)
        pg (:postgres conv-man)]
    (log/info "Starting conversation update for zid:" (:zid conv))
    ;; Need to expose opts for conv-update through config... XXX
    (let [updated-conv   (conv/conv-update conv votes)
          zid            (:zid updated-conv)
          finish-time    (System/currentTimeMillis)
          ; If this is a recompute, we'll have either :full or :reboot, ow/ want to send false
          recompute      (or (:recompute conv) false)]
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
      updated-conv)))

(defn write-conv-updates!
  [{:as conv-man :keys [postgres]} {:as updated-conv :keys [zid]} math-tick]
  ;; TODO Really need to extract these writes so that mod updates do whta they're supposed to! And also run in async/thread for better parallelism
  ; Format and upload main results
  (async/thread
    (doseq [[prep-fn upload-fn] [[prep-main db/upload-math-main] ; main math results, for client
                                 [prep-bidToPid db/upload-math-bidtopid] ; bidtopid mapping, for server
                                 [prep-ptpt-stats db/upload-math-ptptstats]]]
      (->> updated-conv
           prep-fn
           (upload-fn postgres zid math-tick)))
    (log/info "Finished uploading math results for zid:" zid)))

(defn restructure-json-conv
  [conv]
  (-> conv
      (utils/hash-map-subset #{:math_tick :raw-rating-mat :rating-mat :lastVoteTimestamp :mod-out :mod-in :zid :pca :in-conv :n :n-cmts :group-clusters :base-clusters :repness :group-votes :subgroup-clusters :subgroup-votes :subgroup-repness :group-aware-consensus :comment-priorities :meta-tids})
      (assoc :last-vote-timestamp (get conv :lastVoteTimestamp)
             :last-mod-timestamp  (get conv :lastModTimestamp))
      ; Make sure there is an empty named matrix to operate on
      (assoc :raw-rating-mat (nm/named-matrix))
      ; Update the base clusters to be unfolded
      (update :base-clusters clust/unfold-clusters)
      ; Make sure in-conv is a set
      (update :in-conv set)
      (update :mod-out set)
      (update :mod-in set)
      (update :meta-tids set)))


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



;; Message processing functions
;; ----------------------------


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



;; Message processing for conv-actor
;; =================================

;; Here's the multimethod at the core of the messages the conv actor may act upon.

(defmulti react-to-messages
          (fn [conv-man conv message-type messages]
            message-type))

(defmethod react-to-messages :votes
  [conv-man conv _ messages]
  (conv-update conv-man conv messages))

(defmethod react-to-messages :moderation
  [conv-man conv _ messages]
  (conv/mod-update conv messages))

(defmethod react-to-messages :generate_report_data
  [conv-man conv _ messages]
  (let [math-tick (or (:math-tick conv) (:math_tick conv))]
    (doseq [report-task messages]
      (try
        (generate-report-data! conv-man conv math-tick report-task)
        (catch Exception e (log/error e (str "Unable to generate report " (pr-str report-task)))))))
  ;; explicitly return nil so we don't trigger an update
  nil)


;; Error handling

(defn handle-errors
  [conv-man conv-actor conv message-type messages update-error start-time]
  (let [zid (:zid conv-actor)
        zid-str (str "zid=" zid)
        retry-chan (:retry-chan conv-actor)
        notify-message (str "Failed conversation update on " (-> conv-man :config :math-env) " for message-type " message-type " and " zid-str)]
    (try
      (let [stack-trace (notify/error-message-body update-error)]
        (notify/notify-team (:config conv-man) (str "Polismath conv-man error: " message-type) zid notify-message stack-trace))
      (catch Exception e
        (log/error e "Unable to notify team")))
    (log/error update-error notify-message)
    (.printStackTrace update-error)
    ; Try requeing the votes that failed so that if we get more, they'll get replayed
    (try
      (log/info "Re-queueing messages for failed update for" zid-str)
      (async/go (async/>! retry-chan {:message-type message-type :message-batch messages}))
      (catch Exception qe
        (log/error qe (str "MAJOR ERROR! Unable to re-queue votes after conversation update failed for " zid-str))
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
      (conv/conv-update-dump conv messages update-error)
      (catch Exception e
        (log/error "Unable to perform conv-update dump for" zid-str)))))


;; Wrapper around the multimethod above, which handles errors and such

(defn react-to-messages!
  [conv-man conv-actor message-type messages]
  (let [start-time (System/currentTimeMillis)
        {:keys [zid conv retry-chan]} conv-actor
        update-fn
        (fn [conv']
          (try
            (if-let [updated-conv (react-to-messages conv-man conv' message-type messages)]
              (do
                (let [math-tick (or (:math-tick updated-conv) ;; pass through for report generation
                                    (postgres/inc-math-tick (:postgres conv-man) zid))]
                  (write-conv-updates! conv-man updated-conv math-tick))
                updated-conv)
              ;; if nil, don't update, for just side effects
              conv')
            (catch Exception e
              (handle-errors conv-man conv-actor conv' message-type messages e start-time)
              conv')))]
    (swap! conv update-fn)))


;; Start the actor

(defn go-act!
  [conv-man conv-actor]
  (let [{:keys [kill-chan conversations]} conv-man
        {:keys [zid conv message-chan retry-chan]} conv-actor]
    (go-loop []
      ;; If nil comes through as the first message, then the chan is closed, and we should be done, not continue looping forever
      (let [[first-msg c] (async/alts! [kill-chan message-chan] :priority true)]
        (when-not (= c kill-chan)
          (log/debug "Message chan put in queue-message-batch! for zid:" (:zid first-msg))
          ;; If there are any retry messages from a failed recompute, we put them at the front of the message stack.
          ;; But retry messages only get processed in this way if there are new messages that have come in triggering the
          ;; first-msg take above, ensuring we don't just loop forever on a broken message/update.
          (let [retry-msgs (async/poll! retry-chan)
                msgs (vec (concat retry-msgs [first-msg] (take-all! message-chan)))
                ;; Regardless, now we split the messages by message type and process them as below
                split-msgs (split-batches msgs)]
            ;; This acts as a whitelist for messages to run, and also an ordering of preference
            (doseq [message-type [:votes :moderation :generate_report_data]]
              (when-let [messages (get split-msgs message-type)]
                (react-to-messages! conv-man conv-actor message-type messages)))
            (recur)))))))

;; Put the actor together and

(defn conv-actor
  [{:as conv-man :keys [conversations kill-chan config]} zid]
  (log/info "Starting message batch queue and handler routine for conv zid:" zid)
  (let [conv (load-or-init conv-man zid :recompute (:recompute config))
        _ (log/info "Conversation loaded for conv zid:" zid)
        ;; Set up our main message chan
        message-chan (chan 10000)
        ;; Separate channel for messages that we've tried to process but that haven't worked for one reason or another (buffer size not important here)
        retry-chan   (chan 10)
        actor        {:zid zid :conv (atom conv) :message-chan message-chan :retry-chan retry-chan :conv-man conv-man}]
    (go-act! conv-man actor)
    ;; Trigger a conv update as the conv loads, so that state is always consistent
    (react-to-messages! conv-man actor :votes [])
    actor))


(defn add-conv-actor-listener!
  [conv-actor f]
  (add-watch (:conv conv-actor)
             ::conv-actor-state-watch
             (fn [_ _ old-value new-value]
               (when-not (= old-value new-value)
                 (f new-value)))))

;; At the moment this is mostly used for testing, and I'm not sure that we'll want to keep it long term. But let's see...
(defn add-listener!
  "Adds a watch to the conv-actor for the given zid such that the function f will be called when the given conversation
  changes or initializes."
  [conv-man zid f]
  ;; If the conv-actor has already been created, then we add a watch for its :conv atom
  (when-let [conv-actor (-> conv-man :conversations deref (get zid))]
    (add-conv-actor-listener! conv-actor f))
  (add-watch (:conversations conv-man)
             [::conversations-watch zid]
             (fn [_ _ old-value new-value]
               ;; If a conv-actor is added for this zid, set the watch now
               (when-let [new-conv-actor (and (not (get old-value zid))
                                              (get new-value zid))]
                 (add-conv-actor-listener! new-conv-actor f)))))



;; Conversation manager system component
;; =====================================

;; Puts together the conversation actors into a system component.

(defrecord ConversationManager [config postgres metrics conversations kill-chan]
  component/Lifecycle
  (start [component]
    (log/info ">> Starting ConversationManager")
    (let [conversations (atom {})
          kill-chan (async/promise-chan)]
      (assoc component :conversations conversations :kill-chan kill-chan)))
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
      (catch Exception e
        (log/error e "Unable to stop ConvMan component")))
    component))

(defn create-conversation-manager
  []
  (map->ConversationManager {}))


;; How we queue messages up to the conversation manager

;; Need to think about what to do if failed conversations lead to messages piling up in the message queue XXX
(defn queue-message-batch!
  "Queue message batches for a given conversation by zid"
  [{:as conv-man :keys [conversations config kill-chan]} message-type zid message-batch]
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
  (test/run-tests 'conv-man-tests)
  :end-comment)


:ok

