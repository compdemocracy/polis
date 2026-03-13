;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.darwin.core
  "The darwin.core namespace wraps the more pure (+ writing files/zips) code in darwin.export. Deals with parsing the
  params, updating the db status, etc. This gets hooked up in the tasks namespace."
  (:require
   [com.stuartsierra.component :as component]
   [polismath.components.postgres :as db]
   [taoensso.timbre :as log]))
;; We use postgres to persist the status of our exports as a json blob.
;; Here, we're setting up basic postgres read and write helpers.

(defn update-export-status
  [{:keys [postgres]}
   {:keys [zid filename zinvite]}
   document]
  (db/upload-math-exportstatus
   postgres
   zid
   filename
   (db/format-as-json-for-db
    (assoc document
           :filename filename
           :conversation_id zinvite
           :lastupdate (System/currentTimeMillis)))))

(defn notify-of-status
  [darwin params status]
  (update-export-status darwin params {:status status :params params}))


(defn handle-completion!
  [{:as darwin :keys [postgres]} {:as params :keys [filename task_bucket]}]
  (log/info "Completed export computation for filename" filename "params:" (with-out-str (str params)))
  (notify-of-status darwin params "complete")
  (db/mark-task-complete! postgres "generate_export_data" task_bucket))



;; The filename is actually pretty important.
;; It should be unique between different exports, as it is used for postgres tracking.

(defn generate-filename
  "Generates a filename based on request-params"
  [{:keys [zinvite at-time format]}]
  {:pre [zinvite format]}
  (let [last-updated (or at-time (System/currentTimeMillis))
        ext (case format :csv "zip")
        filename (str "polis-export-" zinvite "-" last-updated "." ext)]
    filename))



;; The following is really just a bunch of parameter parsing stuff.
;; Tihs could all possibly be interwoven with the config component as well.

(defn- ->long
  "Try to parse as an integer as long; return nil if not possible."
  [x]
  (if (number? x)
    (long x)
    (try (Long/parseLong x)
         (catch Exception _e nil))))

(defn- parse-and-validate-timeout
  [x]
  (let [x (try (Long/parseLong x)
               (catch Exception _e (throw (Exception. "Invalid timeout value"))))]
    (assert (and x (< 0 x) (>= 29000 x)) "Invalid timout value")
    x))

(def parsers {:at-time ->long
              :format  keyword
              :timeout parse-and-validate-timeout})

;; And finally, our param parser.

(defn params-with-zid
  [darwin params]
  (assoc params
         :zid (or (:zid params)
                  (db/get-zid-from-zinvite (:postgres darwin) (:zinvite params)))))

(defn params-with-filename
  [params]
  (assoc params
         :filename
         (or (:filename params)
             (generate-filename params))))

(defn params-with-zinvite
  [darwin params]
  (assoc params
         :zinvite (or (:zinvite params)
                      (db/get-zinvite-from-zid (:postgres darwin) (:zid params)))))


(defn parsed-params
  "Parses the params for a request, occording to parsers."
  [darwin params]
  ;(log/info "Here are the params:" params)
  (->>
   params
   (reduce
    (fn [m [k v]]
      ;; Don't really need this if we have params instead of query params, but whateves
      (let [k (keyword k)]
        (assoc m k ((or (parsers k) identity) v))))
    {})
   (params-with-zid darwin)
   (params-with-zinvite darwin)
   (params-with-filename)))


;; Route everything together, build handlers, etc


(defrecord Darwin [config postgres conversation-manager]
  component/Lifecycle
  (start [component]
    (log/info ">> Starting darwin component")
    component)
  (stop [component]
    (log/info "<< Stopping darwin component")
    component))


(defn create-darwin
  []
  (map->Darwin {}))


:ok

