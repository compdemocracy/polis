(ns polismath.system
  (:require [polismath.utils :as utils]
            [polismath.components [config :as config :refer [create-config]]
                                  [mongo :as mongo :refer [create-mongo]]
                                  [postgres :as postgres :refer [create-postgres]]
                                  [core-matrix-boot :as core-matrix-boot :refer [create-core-matrix-booter]]
                                  [logger :as logger :refer [create-logger]]]
            [polismath.conv-man :as conv-man :refer [create-conversation-manager]]
            [polismath.utils :as utils]
            [clojure.tools.logging :as log]
            [clojure.tools.namespace.repl :as namespace.repl]
            [clojure.string :as string]
            [clojure.newtools.cli :as cli]
            [com.stuartsierra.component :as component]))

(defn base-system
  "This constructs an instance of the base system components, including config, db, etc."
  [config-overrides]
  {:config               (create-config config-overrides)
   :logger               (component/using (create-logger)               [:config])
   :core-matrix-boot     (component/using (create-core-matrix-booter)   [:config])
   :postgres             (component/using (create-postgres)             [:config])
   :mongo                (component/using (create-mongo)                [:config])
   :conversation-manager (component/using (create-conversation-manager) [:config :core-matrix-boot :mongo])})

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


