(ns polismath.components.postgres
  (:require [polismath.components.env :as env]
            [polismath.util.pretty-printers :as pp]
            [polismath.utils :as utils]
            ;; Replace with as util XXX
            ;[polismath.utils :as utils :refer :all]
            [clojure.stacktrace :refer :all]
            [clojure.tools.logging :as log]
            [clojure.tools.trace :as tr]
            [com.stuartsierra.component :as component]
            [plumbing.core :as pc]
            [korma.core :as ko]
            [korma.db :as kdb]
            [cheshire.core :as ch]
            ;[alex-and-georges.debug-repl :as dbr]
            ))


(defn heroku-db-spec
  "Create a korma db-spec given a heroku db-uri"
  [db-uri]
  (let [[_ user password host port db] (re-matches #"postgres://(?:(.+):(.*)@)?([^:]+)(?::(\d+))?/(.+)" db-uri)
        settings {:user user
                  :password password
                  :host host
                  :port (or port 80)
                  :db db
                  :ssl true
                  :sslfactory "org.postgresql.ssl.NonValidatingFactory"}]
    (kdb/postgres settings)))


(defrecord Postgres [config db-spec]
  component/Lifecycle
  (start [component]
    (log/info "Starting Postgres component")
    (let [db-spec (-> config :database :url heroku-db-spec)]
      (assoc component :db-spec db-spec)))
  (stop [component]
    (log/info "Stopping Postgres component")
    (assoc component :db-spec nil)))

(defn create-postgres
  "Creates a new Postgres component"
  []
  (map->Postgres {}))

(declare users conversations votes participants)

(ko/defentity users
  (ko/pk :uid)
  (ko/entity-fields :uid :hname :username :email :is_owner :created :plan)
  (ko/has-many conversations)
  (ko/has-many votes))

(ko/defentity conversations
  (ko/pk :zid)
  (ko/entity-fields :zid :owner)
  (ko/has-many votes)
  (ko/belongs-to users (:fk :owner)))

(ko/defentity votes
  (ko/entity-fields :zid :pid :tid :vote :created)
  (ko/belongs-to participants (:fk :pid))
  (ko/belongs-to conversations (:fk :zid)))

(ko/defentity participants
  (ko/entity-fields :pid :uid :zid :created)
  (ko/belongs-to users (:fk :uid))
  (ko/belongs-to conversations (:fk :zid)))

(ko/defentity comments
  (ko/entity-fields :zid :tid :mod :modified)
  (ko/belongs-to conversations (:fk :zid)))


(defn poll
  "Query for all data since last-vote-timestamp, given a db-spec"
  [component last-vote-timestamp]
  (try
    (kdb/with-db (:db-spec component)
      (ko/select votes
        (ko/where {:created [> last-vote-timestamp]})
        (ko/order [:zid :tid :pid :created] :asc))) ; ordering by tid is important, since we rely on this ordering to determine the index within the comps, which needs to correspond to the tid
    (catch Exception e
      (log/error "polling failed " (.getMessage e))
      (.printStackTrace e)
      [])))


(defn mod-poll
  "Moderation query: basically look for when things were last modified, since this is the only time they will
  have been moderated."
  [component last-mod-timestamp]
  (try
    (kdb/with-db (:db-spec component)
      (ko/select comments
        (ko/fields :zid :tid :mod :modified)
        (ko/where {:modified [> last-mod-timestamp]
                   :mod [not= 0]})
        (ko/order [:zid :tid :modified] :asc)))
    (catch Exception e
      (log/error "moderation polling failed " (.getMessage e))
      [])))


(def get-users
  (->
    (ko/select* users)
    (ko/fields :uid :hname :username :email :is_owner :created :plan)))


(def get-users-with-stats
  (->
    get-users
    (ko/fields :owned_convs.avg_n_ptpts
               :owned_convs.avg_n_visitors
               :owned_convs.n_owned_convs
               :owned_convs.n_owned_convs_ptptd
               :ptpt_summary.n_ptptd_convs)
    ; Join summary stats of owned conversations
    (ko/join :left
      [(ko/subselect
         conversations
         (ko/fields :owner)
         ; Join participant count summaries per conv
         (ko/join
           [(ko/subselect
              participants
              (ko/fields :zid)
              (ko/aggregate (count (ko/raw "DISTINCT pid")) :n_visitors :zid))
            ; as visitor_summary
            :visitor_summary]
           (= :visitor_summary.zid :zid))
         (ko/join
           :left
           [(ko/subselect
              participants
              (ko/fields :participants.zid [(ko/raw "COUNT(DISTINCT votes.pid) > 0") :any_votes])
              (ko/join votes (and (= :votes.pid :participants.pid)
                                  (= :votes.zid :participants.zid)))
              (ko/aggregate (count (ko/raw "DISTINCT votes.pid")) :n_ptpts :participants.zid))
            ; as ptpt_summary
            :ptpt_summary]
           (= :ptpt_summary.zid :zid))
         ; Average participant counts, and count number of conversations
         (ko/aggregate (avg :visitor_summary.n_visitors) :avg_n_visitors)
         (ko/aggregate (avg :ptpt_summary.n_ptpts) :avg_n_ptpts)
         (ko/aggregate (count (ko/raw "DISTINCT conversations.zid")) :n_owned_convs)
         (ko/aggregate (sum (ko/raw "CASE WHEN ptpt_summary.any_votes THEN 1 ELSE 0 END")) :n_owned_convs_ptptd)
         (ko/group :owner))
       ; as owned_convs
       :owned_convs]
      (= :owned_convs.owner :uid))
    ; Join summary stats on participation
    (ko/join
      :left
      [(ko/subselect
         participants
         (ko/fields :uid)
         (ko/aggregate (count (ko/raw "DISTINCT zid")) :n_ptptd_convs :uid))
       :ptpt_summary]
      (= :ptpt_summary.uid :uid))))


(defn get-users-by-uid
  [component uids]
  (kdb/with-db (:db-spec component)
    (->
      get-users-with-stats
      (ko/where (in :uid uids))
      (ko/select))))


(defn get-users-by-email
  [component emails]
  (kdb/with-db (:db-spec component)
    (->
      get-users-with-stats
      (ko/where (in :email emails))
      (ko/select))))


(defn mongo-collection-name
  "Mongo collection name based on MATH_ENV env variable and hard-coded schema data. Makes sure that
  prod, preprod, dev (and subdevs like chrisdev) have their own noninterfering collections."
  [basename]
  (let [schema-date "2014_08_22"
        env-name    (or (env/env :math-env) "dev")]
    (str "math_" env-name "_" schema-date "_" basename)))

(defn mongo-exports-collection-name
  "Mongo collection name based on MATH_ENV env variable. While the return value of
  mongo-collection-name points to the actual math collections for a given environment, the
  value of this function points to the table which contains export status information for datadumps."
  [basename]
  (let [env-name    (or (env/env :math-env) "dev")]
    (str "exports_" env-name)))


(defn- megabytes
  [^long n]
  (* n 1024 1024))

;; Dear lord this is a monstrosity... need to move this to component XXX
(def
  ^{:doc "Memoized; returns a db object for connecting to mongo"}
  mongo-db
  (memoize
    (fn [mongo-url]
      (let [db (if mongo-url
                 (let [{:keys [conn db]} (mg/connect-via-uri mongo-url)]
                   db)
                 (let [conn (mg/connect)
                       db (mg/get-db conn "local-db")]
                   db))]
        ; Create indices, in case they don't exist
        (doseq [c ["bidtopid" "main" "cache"]]
          (let [c (mongo-collection-name c)]
            (mc/ensure-index db c (array-map :zid 1) {:name (str c "_zid_index") :unique true})))
        ;; An index for lastupdated on "exports" collection
        (mc/ensure-index db "exports" {:lastupdate 1} {:expireAfterSeconds (* (try (Integer/parseInt (:export-expiry-days env/env))
                                                                                  (catch Exception e 10)) ;; Note: make sure env variable exists and move to config component XXX
                                                                              (* 60 60 24))})
        ; set up rolling limit on profile data
        (let [prof-coll (mongo-collection-name "profile")]
          (if-not (mc/exists? db prof-coll)
            (try
              (mc/create db prof-coll {:capped true :size (-> 125 megabytes) :max 200000})
              (catch Exception e
                (log/warn "Unable to create capped profile collection. Perhaps it's already been created?")))))
        ; make sure to return db
        db))))


(defn load-conv
  "Very bare bones reloading of the conversation; no cleanup for keyword/int hash-map key mismatches,
  as found in the :repness"
  [zid]
  (mc/find-one-as-map
    (mongo-db (env/env :mongolab-uri))
    (mongo-collection-name "main")
    {:zid zid}))

(defn format-for-mongo
  "Formats data for mongo, first passing through a prep function which may strip out uneeded junk or
  reshape things. Takes conv and lastVoteTimestamp, though the latter may be moved into the former in update"
  [prep-fn conv]
  (-> conv
    prep-fn
    ; core.matrix & monger workaround: convert to str with cheshire then back
    ch/generate-string
    ch/parse-string))

(defn conv-poll
  "Query for all data since last-vote-timestamp for a given zid, given an implicit db-spec"
  [zid last-vote-timestamp]
  (try
    (kdb/with-db (db-spec)
      (ko/select votes
        (ko/where {:created [> last-vote-timestamp]
                   :zid zid})
        (ko/order [:zid :tid :pid :created] :asc))) ; ordering by tid is important, since we rely on this ordering to determine the index within the comps, which needs to correspond to the tid
    (catch Exception e
      (log/error "polling failed for conv zid =" zid ":" (.getMessage e))
      (.printStackTrace e)
      [])))


