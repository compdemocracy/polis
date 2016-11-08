(ns polismath.system
  (:require [polismath.utils :as utils]
            [polismath.components [config :as config]
                                  [mongo :as mongo]
                                  [postgres :as postgres]
                                  [core-matrix-boot :as core-matrix-boot]
                                  [logger :as logger]]
            [polismath.conv-man :as conv-man]
            [polismath.poller :as poller]
            [polismath.utils :as utils]
            [clojure.tools.logging :as log]
            [clojure.tools.namespace.repl :as namespace.repl]
            [clojure.string :as string]
            [clojure.newtools.cli :as cli]
            [com.stuartsierra.component :as component]))

(defn base-system
  "This constructs an instance of the base system components, including config, db, etc."
  [config-overrides]
  {:config               (config/create-config config-overrides)
   ;:logger               (component/using (logger/create-logger)                 [:config])
   :core-matrix-boot     (component/using (core-matrix-boot/create-core-matrix-booter) [:config])
   :postgres             (component/using (postgres/create-postgres)             [:config])
   :mongo                (component/using (mongo/create-mongo)                   [:config])
   :conversation-manager (component/using (conv-man/create-conversation-manager) [:config :core-matrix-boot :mongo])})

(defn poller-system
  "Creates a base-system and assocs in darwin server related components."
  [config-overrides]
  (let [sys-map
        (merge (base-system config-overrides)
          {:vote-poller (component/using (poller/create-poller :votes)      [:config :postgres :conversation-manager])
           :mod-poller  (component/using (poller/create-poller :moderation) [:config :postgres :conversation-manager])})]
    (log/info "Here's the system keys:" (keys sys-map))
    sys-map))

(defn darwin-system
  "Creates a base-system and assocs in darwin server related components."
  [config-overrides]
  :TODO)

(defn onyx-system
  "Creates a base-system and assocs in polismath onyx worker related components."
  [config-overrides]
  :TODO)

(defn simulator-system
  "Creates a base-system and assocs in a simulation engine."
  [config-overrides]
  :TODO)

(defn create-and-run-system!
  [system config]
  (->> config system (utils/apply-kwargs component/system-map) component/start))

(defn create-and-run-base-system!
  [config]
  (create-and-run-system! base-system config))


