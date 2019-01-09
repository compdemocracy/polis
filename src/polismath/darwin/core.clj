;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.darwin.core
  "The darwin.core namespace wraps the more pure (+ writing files/zips) code in darwin.export. Deals with parsing the
  params, updating the db status, uploading to aws, etc. This gets hooked up in the tasks namespace."
  (:require
    [polismath.darwin.export :as export]
    ;; XXX Deprecate; use component config directly
    ;[polismath.components.env :as env]
    [polismath.components.postgres :as db]
    [clojure.core.async :as async :refer [chan >!! <!! >! <! go]]
    [taoensso.timbre :as log]
    [ring.component.jetty :refer [jetty-server]]
    [ring.util.response :as response]
    [ring.middleware.params :as ring.params]
    [ring.middleware.ssl :as ssl]
    [ring.middleware.keyword-params :as ring.keyword-params]
    [ring.middleware.basic-authentication :as auth :refer [wrap-basic-authentication]]
    [bidi.ring]
    [com.stuartsierra.component :as component]
    [amazonica.aws.s3 :as s3]
    [clj-time.core :as time]
    [clj-http.client :as client]
    [polismath.utils :as utils]
    [clojure.set :as set]
    [polismath.components.postgres :as postgres]))




;; We use postgres to persists the status of our exports as a json blob, and data needed for downloading from AWS.
;; Here, we're setting up basic postgres read and write helpers.

(defn update-export-status
  [{:as darwin :keys [postgres config]}
   {:as params :keys [zid filename zinvite]}
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
    

;; Uh... seems like we're not using `update-export-status` anywhere except for here; should delete one of these functions
;; in favor of the other
(defn notify-of-status
  [darwin params status]
  (update-export-status darwin params {:status status :params params}))


;; We use AWS to store conversation exports whcih took a long time to compute.
;; These exports are set to expire automatically.
;; The number of days before expiry should be stored in env variable :export-expiry-days.
;; This value is used to compute the expiry of the exports postgres blob as well.

(defn aws-cred [darwin]
  (-> darwin :config :aws))

(defn full-aws-path
  [darwin filename]
  (str (-> darwin :config :math-env-string) "/" filename))

(defn upload-to-aws
  [darwin filename]
  (s3/put-object (aws-cred darwin)
                 :bucket-name "polis-datadump"
                 :key (full-aws-path darwin filename)
                 :file (export/full-path darwin filename)))


(defn send-email-notification-via-polis-api!
  [darwin {:as params :keys [zinvite email filename]}]
  (try
    (let [darwin-config (-> darwin :config)
          response
          ;; The next three lines should probably be extracted
          (client/post (str (:webserver-url darwin-config) "/sendEmailExportReady")
                       {:form-params {:webserver_username (:webserver-username darwin-config)
                                      :webserver_pass (:webserver-pass darwin-config)
                                      :email email
                                      :filename filename
                                      :raise false
                                      :conversation_id zinvite}
                        :content-type :json
                        :throw-entire-message? true})]
      (log/info "send email notification response:\n" (with-out-str (clojure.pprint/pprint response))))
    (catch Exception e
      (log/error e "failed to send email:\n"))))


(defn handle-completion!
  [{:as darwin :keys [postgres]} {:as params :keys [filename task_bucket]}]
  (log/info "Completed export computation for filename" filename "params:" (with-out-str (str params)))
  (upload-to-aws darwin filename)
  ;;(upload-to-polis-polismath.darwin.core darwin filename)
  (notify-of-status darwin params "complete")
  (postgres/mark-task-complete! postgres "generate_export_data" task_bucket)
  (when (:email params) (send-email-notification-via-polis-api! darwin params)))



;; The filename is actually pretty iportant.
;; It should be unique between different exports, as is used as the identifying key for the aws buckets, postgres
;; tracking and as part of the API requests.

(defn generate-filename
  "Generates a filename based on request-params"
  [{:as request-params :keys [zinvite at-date format]}]
  {:pre [zinvite format]}
  (let [last-updated (or at-date (System/currentTimeMillis))
        ext (case format :excel "xlsx" :csv "zip")
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
         (catch Exception e nil))))

(defn- between? [a b x]
  (and x (< a x) (> b x)))

(defn- parse-and-validate-timeout
  [x]
  (let [x (try (Long/parseLong x)
               (catch Exception e (throw (Exception. "Invalid timeout value"))))]
    (assert (and x (< 0 x) (>= 29000 x)) "Invalid timout value")
    x))

(def parsers {:at-date ->long
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





(comment
  ;; Here we're putting everything together
  ;; This may not all be 100% correct, as it was copied over from the repl... but I ran through all but the spit and sanity checks pass
  (require '[incanter.charts :as charts]
           '[polismath.runner :as runner]
           '[polismath.system :as system])
  ;(runner/run! system/base-system {:math-env :preprod})
  ;; Load the data for 15117 (zinvite 2ez5beswtc)
  ;(def focus-id 15117)
  (def focus-zinvite "36jajfnhhn")
  (def focus-id 15228)
  (def conv (conv-man/load-or-init (:conversation-manager runner/system) focus-id))
  ;conv
  (matrix/shape (nm/get-matrix (:rating-mat conv)))
  ;; Compute hclust on a cleaned, transposed rating matrix
  (time
    (def hclusters (hclust (cleaned-rating-mat-transpose conv))))
  (count (-> hclusters first :members))
  ;; Compute corr matrix
  (time
    (def corr-mat (correlation-matrix conv)))
  (keys corr-mat)
  (matrix/shape (:matrix corr-mat))
  (def corr-mat' (blockify-corr-matrix corr-mat hclusters))
  (keys corr-mat')
  (count (:comments corr-mat'))
  ;; Spit this out
  (spit-matrix (str focus-zinvite ".corrmat.json") corr-mat)
  (spit-matrix (str focus-zinvite ".corrmat-whclust.json") corr-mat')
  (spit-hclust (str focus-zinvite ".hclust.json") hclusters)
  ;; All done
  :endcomment)

;; Route everything together, build handlers, etc


;; NOOP right now for compatibility
(defrecord Darwin [config postgres conversation-manager handler]
  component/Lifecycle
  (start [component]
    component)
  (stop [component]
    component))


(defn create-darwin
  []
  (map->Darwin {}))


:ok

