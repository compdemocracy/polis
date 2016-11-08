(ns polismath.components.logger
  (:require [com.stuartsierra.component :as component]
            [taoensso.timbre :as log]
            [taoensso.timbre.appenders.core :as appenders]))


;; XXX Hmmm.. this doesn't seem to be working yet. Maybe we need to use timbre for log calls instead of
;; clojure.tools.logging
(defrecord Logger [config]
  component/Lifecycle
  (start [component]
    (log/info ">> Starting config component")
    (log/merge-config!
      {;:middleware [] ; (fns [data]) -> ?data, applied left->right
       ;:timestamp-opts default-timestamp-opts ; {:pattern _ :locale _ :timezone _}
       ;:output-fn default-output-fn ; (fn [data]) -> string
       :appenders {:println-appender
                   {:enabled?   true
                    :async?     false
                    :min-level  nil
                    :rate-limit [[1 250] [10 5000]] ; 1/250ms, 10/5s
                    :output-fn  :inherit
                    :fn ; Appender's fn
                    (fn [data]
                      (let [{:keys [output-fn]} data
                            formatted-output-str (output-fn data)]
                        (println formatted-output-str)))}
                   :file-appender
                   {:spit (appenders/spit-appender {:fname "/path/my-file.log"})}}})
    (log/merge-config!
      (:logging config)))
  (stop [component]
    (log/info "<< Stopping config component")
    component))

(defn create-logger []
  (map->Logger {}))


