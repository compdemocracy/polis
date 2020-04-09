;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.components.config
  (:require [polismath.utils :as utils]
            [taoensso.timbre :as log]
            [com.stuartsierra.component :as component]
            [environ.core :as environ]))


;; I think we need to just move to this: https://github.com/juxt/aero
;; Good set of features without baking in too many assumptions or constraining design


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

(defn ->boolean [x]
  (when x
    ;; anything other than these values will be considered truthy
    (not (#{"false" "0" "no"} x))))


;; XXX This should be computed; that is be a function of the rules.
;; :default specification should be in the rules themselves
(def defaults
  {:math-env   :dev
   :math-schema-date "2014_08_22"
   :server     {:port 8080}
   ;:darwin     {:server-port 3123}
   :export     {:expiry-days 6
                :temp-dir "/tmp/"
                ;; Hmmm should be able to specify a dep on port; aero?
                :private-url-base "http://localhost:8080"}
                ;; Shit... should be able to specify dependency on preprod as well!
   :database   {:pool-size 3}
   :poller     {:votes {:polling-interval 1000}
                :moderation {:polling-interval 1000}
                :tasks {:polling-interval 1000}
                :poll-from-days-ago 10}
   :math       {:matrix-implementation :vectorz}
   :logging    {:file "log/dev.log"
                :level :info}})


(def rules
  "Mapping of env keys to parsing options"
  {:math-env                   {:parse ->keyword}
   ;; Have to use :port since that's what heroku expects...
   :port                       {:path [:server :port] :parse ->long}
   :database-url               {:path [:database :url]}
   :database-for-reads-name    {:path [:database :reads-name]}
   :database-pool-size         {:path [:database :pool-size] :parse ->long}
   :database-ignore-ssl        {:path [:database :ignore-ssl] :parse ->boolean}
   :mailgun-api-key            {:path [:email :api-key]}
   :mailgun-url                {:path [:email :url]}
   :aws-secret-key             {:path [:aws :secret-key]}
   :aws-access-key             {:path [:aws :access-key]}
   :webserver-username         {:path [:webserver-username]}
   :webserver-pass             {:path [:webserver-pass]}
   :export-server-auth-username {:path [:darwin :server-auth-username]}
   :export-server-auth-pass {:path [:darwin :server-auth-pass]}
   :math-matrix-implementation {:path [:math :matrix-implementation] :parse ->keyword}
   ;; TODO Put all these within a :conv-update opt so we can just pass that through to conv-update all at once
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
   :vote-polling-interval      {:parse ->long :path [:poller :votes :polling-interval]
                                :doc "The polling interval for votes, in milliseconds"}
   :mod-polling-interval       {:parse ->long :path [:poller :moderation :polling-interval]
                                :doc "The polling interval for moderation, in milliseconds"}
   ;:initial-polling-timestamp  {:parse ->long :path [:poller :initial-polling-timestamp]
   ;                             :doc "The initial vote and mod polling timestamp (only load convs with votes later than this)"}
   :poll-from-days-ago         {:parse ->long :path [:poller :poll-from-days-ago]}
   ;; Need to think more about the semantics of a recompute; once; always; only if not booted; etc? XXX
   :recompute                  {:parse ->boolean
                                :doc "Whether or not to perform a recompute"}
   ;; Need to think about how to handle options
   :logging-level              {:path [:logging :level] :parse ->keyword
                                :doc "Logging level for timbre; info, debug, error, etc"}
   :logging-file               {:path [:logging :file]
                                :doc "If set, a file to which the log will be appended"}})
   ;; XXX TODO & Thoughts
   ;; Mini batch sizes (see polismath.math.conversation)


(defn assoc-inferred-values
  [{:as config-map :keys [math-env]}]
  (let [math-env-string (name math-env)
        webserver-url (str "https://"
                           (when-not (= math-env :prod) (str math-env-string "."))
                           "pol.is/api/v3")]
    (assoc config-map
      :math-env-string math-env-string
      :webserver-url webserver-url)))



(defn get-environ-config [rules env]
  ;; reduce over rules and assoc-in mappings into empty map
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
    ;; Then infer additional values
   (assoc-inferred-values
     (deep-merge defaults
                 ;(read-string (slurp "config.edn"))
                 (get-environ-config rules environ/env)
                 overrides)))
  ([] (get-config {})))

(defrecord Config [overrides]
  component/Lifecycle
  (start [component]
    (log/info ">> Starting config component")
    (into component (get-config overrides)))
  (stop [component]
    (log/info "<< Stopping config component")
    component))

(defn create-config
  "Create a new instance of a Config component, with config-overrides."
  ([config-overrides]
   (Config. config-overrides))
  ([] (create-config {})))


:ok


;; XXX This bit of refactoring is a WIP for switching to aero and mount (v component)...

;(defmethod aero/reader `keyword
;  [_ _ value]
;  (keyword value))
;
;(defn get-config
;  ([profile overrides]
;   (deep-merge (get-environ-conifg rules)))
;  ([profile] (get-config profile {}))
;  ([] (get-config :dev)))
;
;;; We use the overrides atom to allow the system start function to specify specific overrides
;(defonce profile (atom :dev))
;(defonce overrides (atom nil))
;
;(defstate config
;          :start (do (log/info ">> Starting config component")
;                     (get-config profile overrides))
;          :stop (do (log/info "<< Stopping config component")
;                    (reset! overrides nil)))

