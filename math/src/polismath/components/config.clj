;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.components.config
  (:require
   [clojure.string :as string]
   [com.stuartsierra.component :as component]
   [environ.core :as environ]
   [taoensso.timbre :as log]))


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


(def defaults
  {:math-schema-date "2014_08_22"
   :server     {:port 8080}
   :export     {:expiry-days 6
                :temp-dir "/tmp/"
                :private-url-base "http://localhost:8080"}
   :database   {:pool-size 3}
   :poller     {:votes {:polling-interval 1000}
                :moderation {:polling-interval 1000}
                :tasks {:polling-interval 1000}
                :poll-from-days-ago 10}
   :math       {:matrix-implementation :vectorz}
   :logging    {:file "log/dev.log"
                :level :warn}})

(defn ->long-list [x]
  (when x
    (->> (string/split x #",")
         (map ->long)
         (set))))


(def rules
  "Mapping of env keys to parsing options"
  {:port                       {:path [:server :port] :parse ->long}
   :database-url               {:path [:database :url]}
   :database-for-reads-name    {:path [:database :reads-name]}
   :database-pool-size         {:path [:database :pool-size] :parse ->long}
   :database-ignore-ssl        {:path [:database :ignore-ssl] :parse ->boolean}
   :math-zid-blocklist         {:path [:poller :zid-blocklist] :parse ->long-list}
   :math-zid-allowlist         {:path [:poller :zid-allowlist] :parse ->long-list}
   :export-server-auth-username {:path [:darwin :server-auth-username]}
   :export-server-auth-pass    {:path [:darwin :server-auth-pass]}
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
   :export-expiry-days         {:path [:export :expiry-days] :parse ->long
                                :doc "The number of days before a data export record gets removed"}
   :vote-polling-interval      {:parse ->long :path [:poller :votes :polling-interval]
                                :doc "The polling interval for votes, in milliseconds"}
   :mod-polling-interval       {:parse ->long :path [:poller :moderation :polling-interval]
                                :doc "The polling interval for moderation, in milliseconds"}
   :poll-from-days-ago         {:parse ->long :path [:poller :poll-from-days-ago]}
   :recompute                  {:parse ->boolean
                                :doc "Whether or not to perform a recompute"}
   :logging-level              {:path [:logging :level] :parse ->keyword
                                :doc "Logging level for timbre; info, debug, error, etc"}
   :logging-file               {:path [:logging :file]
                                :doc "If set, a file to which the log will be appended"}})


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
   (deep-merge defaults
               (get-environ-config rules environ/env)
               overrides))
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
