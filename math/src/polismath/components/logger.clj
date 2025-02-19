;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.components.logger
  (:require [com.stuartsierra.component :as component]
            [taoensso.timbre :as log]
            [taoensso.timbre.appenders.core :as appenders]))


;; XXX Hmmm.. this doesn't seem to be working yet. Maybe we need to use timbre for log calls instead of
;; clojure.tools.logging
(defrecord Logger [config]
  component/Lifecycle
  (start [component]
    ;; Set minimum level first before any other logging happens
    (when-let [level (get-in config [:logging :level])]
      (log/set-level! level))
    ;; First merge the logging config from system config
    (log/merge-config!
      (:logging config))
    ;; Then merge appender config, inheriting the min-level from system config
    (log/merge-config!
      {:appenders {:println-appender
                   {:enabled?   true
                    :async?     false
                    :min-level  (get-in config [:logging :level] :warn)  ; Use system config level or default to :warn
                    :rate-limit [[1 250] [10 5000]] ; 1/250ms, 10/5s
                    :output-fn  :inherit
                    :fn ; Appender's fn
                    (fn [data]
                      (let [{:keys [output-fn]} data
                            formatted-output-str (output-fn data)]
                        (println formatted-output-str)))}
                   :file-appender
                   {:spit (appenders/spit-appender {:fname (get-in config [:logging :file] "dev.log")})}}})
    component)
  (stop [component]
    (log/info "<< Stopping config component")
    component))

(defn create-logger []
  (map->Logger {}))
