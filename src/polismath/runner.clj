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
  [["-r" "--recompute"]])

(defn usage [options-summary]
  (->> ["Polismath stormspec"
        "Usage: lein run [subcommand] [options]"
        ""
        (str "Subcommand options: " (string/join " " (keys subcommands)))

        ""
        "Other options:"
        options-summary]
   (string/join \newline)))

(defn parse-date
  [s]
  (->> (clojure.string/split s #"\s+")
       (map #(Integer/parseInt %))
       (apply t/date-time)
       co/to-long))


(def export-cli-options
  [["-z" "--zid ZID"           "ZID on which to do an export" :parse-fn #(Integer/parseInt %)]
   ["-Z" "--zinvite ZINVITE"   "ZINVITE code on which to perform an export"]
   ["-u" "--user-id USER_ID"   "Export all conversations associated with USER_ID, and place in zip file" :parse-fn #(Integer/parseInt %)]
   ["-a" "--at-date AT_DATE"   "A string of YYYY MM DD HH MM SS (in UTC)" :parse-fn parse-date]
   ["-f" "--format FORMAT"     "Either csv, excel or (soon) json" :parse-fn keyword :validate [#{:csv :excel} "Must be either csv or excel"]]
   ["-h" "--help"              "Print help and exit"]])

(defn error-msg [errors]
  (str "The following errors occurred while parsing your command:\n\n"
       (clojure.string/join \newline errors)))

(defn help-msg [options]
  (str "Export a conversation or set of conversations according to the options below:\n\n"
       \tab
       "filename" \tab "Filename (or file basename, in case of zip output, implicit or explicit" \newline
       (clojure.string/join \newline
                            (for [opt cli-options]
                              (apply str (interleave (repeat \tab) (take 3 opt)))))))

;;; This needs to be cleaned up and integrated somehow; Different mode though, not sure exactly how to..

(defn export-main
  [arguments options]
  (let [filename (first arguments)
        options (assoc options :env-overrides {:math-env "prod"} :filename filename)]
    (if-let [uid (:user-id options)]
      ;; maybe here check if filename ends in zip and add if not; safest, and easiest... XXX
      (with-open [file (io/output-stream filename)
                  zip  (ZipOutputStream. file)]
        (doseq [zid (export/get-zids-for-uid darwin uid)]
          (let [zinvite (get-zinvite-from-zid darwin zid)
                ext (case (:format options) :excel "xls" :csv "csv")]
            (println "Now working on conv:" zid zinvite)
            (export-conversation darwin
                                 (assoc options
                                   :zid zid
                                   :zip-stream zip
                                   :entry-point (str (zipfile-basename filename) "/" zinvite "." ext))))))
      (export-conversation darwin options))
    (exit 0 "Export complete")))


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
  (try
    ;(run! system/base-system)
    (stop!)
    (run! system/poller-system)
    :ok (catch Exception e (.printStackTrace e) e))

  ;(require '[polismath.conv-man :as conv-man])
  ;(let [conv-man (:conversation-manager system)]
    ;(conv-man/queue-message-batch! conv-man ))

  (stop!))




