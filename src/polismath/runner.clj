;; Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.runner
  "This namespace is responsible for running systems"
  (:require [polismath.system :as system]
            ;[polismath.stormspec :as stormspec :refer [storm-system]]
            [polismath.utils :as utils]
            ;; TODO Replace this with the canonical clojure.tools.cli once storm is removed
            [clojure.newtools.cli :as cli]
            [clojure.tools.namespace.repl :as namespace.repl]
            [taoensso.timbre :as log]
            [clojure.string :as string]
            [com.stuartsierra.component :as component]))


(defonce system nil)

;; Should build this to be an atom, and build something that intiates this state from a config file.
;; So when you reset, it reboots all systems.

(defn init!
  ([system-map-generator config-overrides]
   (alter-var-root #'system
     (constantly (utils/apply-kwargs component/system-map (system-map-generator config-overrides)))))
  ([system-map-generator]
   (init! system-map-generator {})))

(defn start! []
  (alter-var-root #'system component/start))

(defn stop! []
  (alter-var-root #'system
    (fn [s] (when s (component/stop s)))))

(defn run!
  ([system-map-generator config-overrides]
   (init! system-map-generator config-overrides)
   (start!))
  ([system-map-generator]
   (run! system-map-generator {})))

;(defonce -runner! nil)
(defn -runner! [] (run! (system/base-system {})))

(defn system-reset!
  ([system-map-generator config-overrides]
   (stop!)
   (alter-var-root #'-runner! (partial run! system-map-generator config-overrides))
   ;; Not sure if this -runner! thing will work, but giving it a try. If it does we can stashthe system and
   ;; config-overrides as well.
   (namespace.repl/refresh :after 'polismath.system/runner!)))

(def subcommands
  {;"storm" stormspec/storm-system ;; remove...
   ;"onyx" system/onyx-system ;; soon...
   "poller" system/poller-system
   "darwin" system/darwin-system
   "simulator" system/simulator-system})

;; TODO Build nice cli settings forking on subcommand, and tie in sanely with options comp

;; QUESTION How do we fork things nicely on command that get run and exit, vs long lived?

(def cli-options
  "Has the same options as simulation if simulations are run"
  [
   ;; old storm setting...
   ;["-n" "--name" "Cluster name; triggers submission to cluster" :default nil]
   ["-r" "--recompute"]])

(defn usage [options-summary]
  (->> ["Polismath stormspec"
        "Usage: lein run [subcommand] [options]"
        ""
        (str "Subcommand options: " (string/join " " (keys subcommands)))

        ""
        "Other options:"
        options-summary]
   (string/join \newline)))

(defn -main [& args]
  (let [{:keys [arguments options errors summary]} (cli/parse-opts args cli-options)]
    (log/info "Runner main function executed")
    (cond
      ;; Help message
      (:help options)
      (utils/exit 0 (usage summary))
      ;; Error in parsing (this should really catch the below condition as well
      (:errors options)
      (utils/exit 1 (str "Found the following errors:" \newline (:errors options)))
      ;; Example:
      ;;; Specifically catch the first argument here needing to be
      ;(nil? (first arguments))
      ;(utils/exit 1 "Must specify a subcommand!")
      :else
      ;; For now, we'll set the default to be the "poller"
      (let [subcommand (or (first arguments) "poller")
            system-map-generator (subcommands subcommand)
            _ (log/info "Running subcommand:" subcommand)
            system (system/create-and-run-system! system-map-generator options)]
        (loop []
          (Thread/sleep 1000)
          (recur))))))


(comment
  ;(run! system/poller-system)
  (run! system/base-system)

  (conv-man/load-or-init)

  ;(require '[polismath.conv-man :as conv-man])
  ;(let [conv-man (:conversation-manager system)]
    ;(conv-man/queue-message-batch! conv-man ))

  (stop!)
  :endcomment)




