;; Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.system
  (:require [polismath.utils :as utils]
            [polismath.components [config :as config]
                                  [postgres :as postgres]
                                  [core-matrix-boot :as core-matrix-boot]
                                  [logger :as logger]
                                  [server :as server]]
            [polismath.conv-man :as conv-man]
            [polismath.poller :as poller]
            [polismath.tasks :as tasks]
            [polismath.darwin.core :as darwin]
            [polismath.utils :as utils]
            [taoensso.timbre :as log]
            [clojure.tools.namespace.repl :as namespace.repl]
            [clojure.string :as string]
            [clojure.tools.cli :as cli]
            [com.stuartsierra.component :as component]))

(defn base-system
  "This constructs an instance of the base system components, including config, db, etc."
  [config-overrides]
  {:config               (config/create-config config-overrides)
   ;:logger               (component/using (logger/create-logger)                 [:config])
   :core-matrix-boot     (component/using (core-matrix-boot/create-core-matrix-booter) [:config])
   :postgres             (component/using (postgres/create-postgres)             [:config])
   :conversation-manager (component/using (conv-man/create-conversation-manager) [:config :core-matrix-boot :postgres])})

(defn poller-system
  "Creates a base-system and assocs in darwin server related components."
  [config-overrides]
  (merge
    (base-system config-overrides)
    {:vote-poller (component/using (poller/create-poller :votes)      [:config :postgres :conversation-manager])
     :mod-poller  (component/using (poller/create-poller :moderation) [:config :postgres :conversation-manager])}))

(defn task-system
  [config-overrides]
  (merge
    (base-system config-overrides)
    {:darwin      (component/using (darwin/create-darwin) [:config :postgres :conversation-manager])
     :task-poller (component/using (tasks/create-task-poller) [:config :darwin :postgres :conversation-manager])}))

(defn export-system
  [config-overrides]
  (log/info "export system overrides:" config-overrides)
  (merge
    (base-system config-overrides)
    {:darwin      (component/using (darwin/create-darwin) [:config :postgres :conversation-manager])}))

(defn full-system
  [config-overrides]
  (merge
    (poller-system config-overrides)
    (task-system config-overrides)))

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


