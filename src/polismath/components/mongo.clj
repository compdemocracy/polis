(ns polismath.components.mongo
  (:require [polismath.utils :as utils]
            [clojure.tools.logging :as log]
            [com.stuartsierra.component :as component]
            [cheshire.core :as ch]
            [monger.core :as mg]
            [monger.collection :as mc]))


;; This should maybe be using the mongo component instance instead of config directly
(defn mongo-collection-name
  "Mongo collection name based on math-env and math-schema-date config variables. Makes sure that
  prod, preprod, dev (and subdevs like chrisdev or mikedev) have their own noninterfering collections.
  Used for actual math results."
  [{:keys [math-schema-date math-env] :as config} basename]
  (str "math_" math-env "_" math-schema-date "_" basename))

(defn mongo-exports-collection-name
  "Mongo collection name based on math-env config variable. Makes sure that prod, preprod, dev (and
  subdevs like chrisdev or mikedev) have their own noninterfering collections. Points to collection
  for export status information."
  [{:keys [math-env] :as config} basename]
    (str "exports_" math-env))


(defn- megabytes
  [^long n]
  (* n 1024 1024))

(defn get-connection-and-db [{:keys [mongo-url] :as config}]
  (if (:mongo-url config)
    (let [{:keys [conn db]} (mg/connect-via-uri mongo-url)]
      [conn db])
    (let [conn (mg/connect)]
      [conn (mg/get-db conn "local-db")])))

(defn setup-rolling-profile-collection!
  [db]
  (let [prof-coll (mongo-collection-name "profile")]
    (if-not (mc/exists? db prof-coll)
      (try
        (mc/create db prof-coll {:capped true :size (-> 125 megabytes) :max 200000})
        (catch Exception e
          (log/warn "Unable to create capped profile collection. Perhaps it's already been created?"))))))

(defn setup-indices!
  [config db]
  ; Create indices, in case they don't exist
  (doseq [c ["bidtopid" "main" "cache"]]
    (let [c (mongo-collection-name c)]
      (mc/ensure-index db c (array-map :zid 1) {:name (str c "_zid_index") :unique true})))
  ;; An index for lastupdated on "exports" collection
  (mc/ensure-index db "exports" {:lastupdate 1} {:expireAfterSeconds (* (try (Integer/parseInt (:export-expiry-days config))
                                                                            (catch Exception e 10)) ;; Note: make sure env variable exists and move to config component XXX
                                                                        (* 60 60 24))}))

(defrecord Mongo [config conn db]
  component/Lifecycle
  (start [component]
    (log/info "Starting Mongo component with mongo-url:" (:mongo-url config))
    (if-not (and conn db)
      (let [[conn db] (get-connection-and-db config)]
        (setup-rolling-profile-collection! db)
        (setup-indices! config db)
        (assoc component :conn conn :db db))
      component))

  (stop [component]
    (log/info "Stopping Mongo component")
    (mg/disconnect conn)
    (assoc component :conn nil :db nil)))


;; Public API

(defn load-conv
  "Very bare bones reloading of the conversation; no cleanup for keyword/int hash-map key mismatches,
  as found in the :repness"
  [mongo zid]
  (mc/find-one-as-map
    (:db mongo)
    (mongo-collection-name (:config mongo) "main")
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

