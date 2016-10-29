(ns polismath.components.config
  (:require [polismath.utils :as utils]
            [clojure.tools.logging :as log]
            [com.stuartsierra.component :as component]
            [environ.core :as environ]))


(defn ->long [x]
  (try
    (Long/parseLong x)
    (catch Exception e
      (when-not (= x "")
        ;; Otherwise, assume nil was intended...
        (log/warn "Failed to parse ->long:" x))
      nil)))

(defn ->keyword [x]
  ;; Otherwise want to return nil, so merging works
  (when (and x (not (= x "")))
    (keyword x)))


;; XXX This should be computed; that is be a function of the rules.
;; :default specification should be in the rules themselves
(def defaults
  {:nrepl-port 12345
   :math-env   :dev
   :darwin     {:server-port 3123}
   ;; XXX Hmm... How do we express a dependency here?
   :primary-polis-url :localhost ;; Must do it in the component load...
   :database   {:pool-size 3}
   :math-schema-date "2014_08_22"
   :export     {:expiry-days 10}
   :storm      {:execution    :local
                :cluster-name "polis-cluster"
                :workers      3
                :spouts {:votes {:polling-interval 2000}
                         :moderation {:polling-interval 5000}}}

   :math       {:matrix-implementation :vectorz}
   :logging    {:file "log/dev.log"
                :level :info}})


(def rules
  "Mapping of env keys to parsing options"
  {:nrepl-port                 {:parse ->long}
   :math-env                   {:parse ->keyword}
   ;; Have to use :port since that's what heroku expects...
   :port                       {:path [:darwin :server-port] :parse ->long}
   :database-url               {:path [:database :url]}
   :database-for-reads-name    {:path [:database :reads-name]}
   :database-pool-size         {:path [:database :pool-size] :parse ->long}
   :mongolab-uri               {:path [:mongo :url]}
   :mailgun-api-key            {:path [:email :api-key]}
   :mailgun-url                {:path [:email :url]}
   :primary-polis-url          {:path [:email :api-key]}
   :math-matrix-implementation {:path [:math :matrix-implementation] :parse ->keyword}
   :math-cutoff-medium         {:path [:math :cutoffs :medium] :parse ->long
                                :doc "This is the maximum size of a conversation before running in :medium mode"}
   :math-cutoff-large          {:path [:math :cutoffs :large] :parse ->long
                                :doc "This is the maximum size of a conversation before running in :large mode"}
   :math-cutoff-max-ptpts      {:path [:math :cutoffs :max-ptpts] :parse ->long
                                :doc "This is the maximum number of participants before the conversation stops accepting new participants"}
   :math-cutoff-max-cmnts      {:path [:math :cutoffs :max-ptpts] :parse ->long
                                :doc "This is the maximum number of comments before the conversation stops accepting new comments"}
   :math-schema-date           {:doc "This helps us version our mongo buckets."}
   ;; Should change these to be more abstract in key name; not hostedgraphite-apikey; just graphite-apikey etc XXX
   :hostedgraphite-apikey      {:path [:meta :graphite :api-key]
                                :doc "API key for graphite db (perf monitoring)"}
   :hostedgraphite-hostname    {:path [:meta :graphite :hostname]
                                :doc "The hostname for sending messages to graphite"}
   :export-expiry-days         {:path [:export :expiry-days] :parse ->long
                                :doc "The number of days before a mongo record representing a data exports gets removed"}
   :vote-polling-interval      {:parse ->long :path [:storm :spouts :votes :polling-interval]
                                :doc "The polling interval for votes, in milliseconds"}
   :mod-polling-interval       {:parse ->long :path [:storm :spouts :moderation :polling-interval]
                                :doc "The polling interval for moderation, in milliseconds"}
   ;; Need to think more about the semantics of a recompute; once; always; only if not booted; etc? XXX
   :recompute                  {:parse boolean
                                :doc "Whether or not to perform a recompute"}
   ;; Need to think about how to handle options
   :storm-execution            {:path [:storm :execution] :options [:local :distributed] :parse ->keyword
                                :doc "Whether to run storm as a distributed cluster (StormSubmitter) or in local mode (LocalCluster)"}
   :storm-cluster-name         {:path [:storm :cluster-name]
                                :doc "Name of the cluster to run on in distributed mode"}
   :storm-workers              {:path [:storm :workers] :parse ->long
                                :doc "Number of storm cluster workers for distributed mode"}
   :logging-level              {:path [:logging :level] :parse ->keyword
                                :doc "Logging level for timbre; info, debug, error, etc"}
   :logging-file               {:path [:logging :file]
                                :doc "If set, a file to which the log will be appended"}})
   ;; XXX TODO & Thoughts
   ;; Mini batch sizes (see polismath.math.conversation)


(defn get-environ-config [rules env]
  (reduce
    (fn [config [name {:keys [parse path] :or {parse identity}}]]
      (if-let [env-var-val (get env name)]
        (assoc-in config (or path [name]) (parse env-var-val))
        config))
    {}
    rules))

(defn deep-merge
  "Like merge, but merges maps recursively."
  [& maps]
  (if (every? #(or (map? %) (nil? %)) maps)
    (apply merge-with deep-merge maps)
    (last maps)))

(defn get-config
  ([overrides]
   (deep-merge defaults
               ;(read-string (slurp "config.edn"))
               (get-environ-config rules environ/env)
               overrides))
  ([] (get-config {})))

(defrecord Config [overrides]
  component/Lifecycle
  (start [component]
    (log/info "Starting config component")
    (into component (get-config overrides)))
  (stop [component]
    component))

(defn create-config
  "Create a new instance of a Config component, with config-overrides."
  ([config-overrides]
   (Config. config-overrides))
  ([] (create-config {})))


:ok

