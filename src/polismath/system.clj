(ns polismath.system
  (:require [polismath.utils :as utils]
            [polismath.components [config :as config :refer [create-config]]
                                  [mongo :as mongo :refer [create-mongo]]
                                  [postgres :as postgres :refer [create-postgres]]
                                  [core-matrix-boot :as core-matrix-boot :refer [create-core-matrix-booter]]]
            [polismath.conv-man :as conv-man :refer [create-conversation-manager]]
            [polismath.stormspec :as stormspec]
            [polismath.utils :as utils]
            [clojure.tools.logging :as log]
            [clojure.tools.namespace.repl :as namespace.repl]
            [clojure.string :as string]
            [clojure.newtools.cli :as cli]
            [com.stuartsierra.component :as component]
            ))

(defn base-system
  "This constructs an instance of the base system components, including config, db, etc."
  [config-overrides]
  {:config               (create-config config-overrides)
   :core-matrix-boot     (component/using (create-core-matrix-booter)   [:config])
   :postgres             (component/using (create-postgres)             [:config])
   :mongo                (component/using (create-mongo)                [:config])
   :conversation-manager (component/using (create-conversation-manager) [:config :core-matrix-boot :mongo])
   })

(defn storm-system
  "Creates a base-system and assocs in polismath storm worker related components."
  [config-overrides]
  (merge (base-system config-overrides)
         {:storm-cluster (component/using (stormspec/create-storm-cluster) [:config :conversation-manager :topology])}))

(defn darwin-system
  "Creates a base-system and assocs in darwin server related components."
  [config-overrides]
  :TODO
  )

(defn onyx-system
  "Creates a base-system and assocs in polismath onyx worker related components."
  [config-overrides]
  :TODO
  )

(defn simulator-system
  "Creates a base-system and assocs in a simulation engine."
  [config-overrides]
  :TODO
  )


;; # System API

(defonce system nil)

(defn init!
  ([system-map-fn config-overrides]
   (alter-var-root #'system
     (constantly (utils/apply-kwargs component/system-map (system-map-fn config-overrides)))))
  ([system-map-fn]
   (init! system-map-fn {})))

(defn start! []
  (alter-var-root #'system component/start))

(defn stop! []
  (alter-var-root #'system
    (fn [s] (when s (component/stop s)))))

(defn run!
  ([system-map-fn config-overrides]
   (init! system-map-fn config-overrides)
   (start!))
  ([system-map-fn]
   (run! system-map-fn {})))

(defonce -runner! nil)

(defn system-reset!
  ([system-map-fn config-overrides]
   (stop!)
   (alter-var-root #'-runner! (partial run! system-map-fn config-overrides))
   ;; Not sure if this -runner! thing will work, but giving it a try. If it does we can stashthe system and
   ;; config-overrides as well.
   (namespace.repl/refresh :after 'polismath.system/runner!)))



(def subcommands
  {"storm" storm-system
   "darwin" darwin-system
   "onyx" onyx-system
   "simulator" simulator-system})


(def cli-options
  "Has the same options as simulation if simulations are run"
  [["-n" "--name" "Cluster name; triggers submission to cluster" :default nil]
   ["-r" "--recompute"]])

(defn usage [options-summary]
  (->> ["Polismath stormspec"
        "Usage: lein run [subcommand] [options]"
        ""
        "Subcommand options: storm, darwin, onyx, simulator"
        ""
        "Other options:"
        options-summary]
   (string/join \newline)))

(defn -main [& args]
  (let [{:keys [arguments options errors summary]} (cli/parse-opts args cli-options)]
    (log/info "Submitting storm topology")
    (cond
      (:help options)   (utils/exit 0 (usage summary))
      (:errors options) (utils/exit 1 (str "Found the following errors:" \newline (:errors options)))
      :else 
      (let [system-map-fn (subcommands (first arguments))]
        (start! system-map-fn)))))

(comment
  (try
    (run! storm-system)
    :ok (catch Exception e (.printStackTrace e) e))
  )
