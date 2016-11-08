(ns polismath.components.mongo
  (:require [polismath.utils :as utils]
            [clojure.tools.logging :as log]
            [com.stuartsierra.component :as component]
            [cheshire.core :as ch]
            [monger.core :as mg]
            [monger.collection :as mc]))


(defn collection-name
  "Mongo collection name based on math-env and math-schema-date config variables. Makes sure that
  prod, preprod, dev (and subdevs like chrisdev or mikedev) have their own noninterfering collections."
  ([mongo rootname]
   (let [{:keys [math-schema-date math-env]} (:config mongo)]
     (str rootname "_" math-env "_" math-schema-date)))
  ([mongo rootname basename] (str (collection-name mongo rootname) basename)))

(defn math-collection-name
  "As in collection-name function, with rootname bound to 'math'; used for actual math results."
  [mongo basename]
  (collection-name mongo "math" basename))

(defn exports-collection-name
  "As in collection-name function, with rootname bound to 'math'; used for actual math results."
  [mongo]
  (collection-name mongo "exports"))


(defn- megabytes
  [^long n]
  (* n 1024 1024))

(defn get-connection-and-db!
  "Connects either to (-> config :mongo :url), or a local temp mongo db if nil, and assocs in the connection
  and db to the mongo record as the return value."
  [{:keys [config] :as mongo}]
  (merge mongo
         (if-let [mongo-url (-> config :mongo :url)]
           (mg/connect-via-uri mongo-url)
           (let [conn (mg/connect)]
             {:conn conn :db (mg/get-db conn "local-db")}))))

(defn setup-rolling-profile-collection!
  "Sets up the rolling profile collection, if not already present in the mongo db. Returns mongo for
  threading convenience."
  [{:keys [db] :as mongo}]
  (let [prof-coll (math-collection-name mongo "profile")]
    (if-not (mc/exists? db prof-coll)
      (try
        (mc/create db prof-coll {:capped true :size (-> 125 megabytes) :max 200000})
        (catch Exception e
          (log/warn "Unable to create capped profile collection. Perhaps it's already been created?")))))
  mongo)

(defn setup-indices!
  "Set up zid indices for upserting and more efficient queries. Also create expiring index for export records."
  [{:keys [config db] :as mongo}]
  ; Create indices, in case they don't exist
  (doseq [c (map (partial math-collection-name mongo)
                 ["bidtopid" "main" "cache"])]
    (mc/ensure-index db c (array-map :zid 1) {:name (str c "_zid_index") :unique true}))
  ;; An index for lastupdated on "exports" collection
  (mc/ensure-index db (exports-collection-name mongo) {:lastupdate 1} {:expireAfterSeconds (-> config :export :expiry-days (* 60 60 24))})
  mongo)

(defrecord Mongo [config conn db]
  component/Lifecycle
  (start [component]
    (log/info ">> Starting Mongo component")
    (if-not (and conn db)
      (-> component
          get-connection-and-db!
          setup-rolling-profile-collection!
          setup-indices!)
      component))

  (stop [component]
    (log/info "<< Stopping Mongo component")
    (mg/disconnect conn)
    (assoc component :conn nil :db nil)))


(defn create-mongo []
  (map->Mongo {}))


;; Public API

(defn load-conv
  "Very bare bones reloading of the conversation; no cleanup for keyword/int hash-map key mismatches,
  as found in the :repness"
  [mongo zid]
  (mc/find-one-as-map
    (:db mongo)
    (collection-name (:config mongo) "main")
    {:zid zid}))

(defn format-for-mongo
  "Formats data for mongo, first passing through a prep function which may strip out uneeded junk or
  reshape things. Takes conv and lastVoteTimestamp, though the latter may be moved into the former in update"
  [conv]
  (-> conv
      ; core.matrix & monger workaround: convert to str with cheshire then back
      ch/generate-string
      ch/parse-string))

(defn zid-upsert
  "Perform upsert of new results on mongo collection name based on :zid of new-results"
  [mongo collection-name new-results]
  (mc/update
    (:db mongo)
    collection-name
    {:zid (or (:zid new-results) ; covering our bases for strings or keywords due to cheshire hack
              (get new-results "zid"))}
    new-results
    {:upsert true}))


(defn insert
  "Perform insert to mongo collection"
  [mongo collection-name object]
  (mc/insert
    (:db mongo)
    collection-name
    object))


