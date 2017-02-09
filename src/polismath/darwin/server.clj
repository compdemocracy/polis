;; Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.darwin.server
  (:require
    [polismath.darwin.export :as export]
    ;; XXX Deprecate; use component config directly
    ;[polismath.components.env :as env]
    [clojure.core.async :as async :refer [chan >!! <!! >! <! go]]
    [taoensso.timbre :as log]
    [ring.component.jetty :refer [jetty-server]]
    [ring.util.response :as response]
    [ring.middleware.params :as ring.params]
    [ring.middleware.ssl :as ssl]
    [ring.middleware.keyword-params :as ring.keyword-params]
    [ring.middleware.basic-authentication :as auth :refer [wrap-basic-authentication]]
    [bidi.bidi :as bidi]
    [bidi.ring]
    [com.stuartsierra.component :as component]
    [monger.collection :as mc]
    ;[hiccup.core :as hiccup]
    [amazonica.aws.s3 :as s3]
    [clj-time.core :as time]
    [clj-http.client :as client]
    [polismath.components.mongo :as mongo]
    [polismath.utils :as utils]))






(defn full-path [darwin filename]
  (str (or (-> darwin :config :export :temp-dir) "/tmp/")
       filename))

(defn private-app-url-base [darwin]
  (or (-> darwin :config :export :private-url-base)))

;(defn public-app-url-base [darwin]
;  (or (-> darwin :config :export :public-url-base) "https://pol.is/api/v3"))

(defn private-url
  [darwin & path]
  (apply str (private-app-url-base darwin) "/" path))

;(defn public-url
;  [darwin & path]
;  (apply str (public-app-url-base darwin) "/" path))


;; A ping handler will just be for debugging purposes

(defn ping-handler
  "Simple ping handler. Returns response with edn representation of the request as the body.
  For testing purposes."
  [request]
  {:status  200
   :headers {"Content-Type" "text/plain"}
   :body (with-out-str (clojure.pprint/pprint request))})




;; We use mongo to persists the status of our exports, and data needed for downloading from AWS.
;; Here, we're setting up basic mongo read and write helpers.

(defn update-export-status
  [{:as darwin :keys [mongo]} filename zinvite document]
  (mongo/upsert
    (:mongo darwin)
    (mongo/collection-name mongo "exports")
    {:filename filename :zinvite zinvite}
    (mongo/format-for-mongo
      (assoc document
        :filename filename
        :zinvite zinvite
        :lastupdate (System/currentTimeMillis)))))

(defn get-export-status
  [{:as darwin :keys [mongo]} filename zinvite]
  (mc/find-one (:db mongo)
               (mongo/collection-name mongo "exports")
               {:filename filename :zinvite zinvite}))

(defn notify-mongo
  [darwin filename status params]
  (update-export-status darwin filename (:zinvite params) {:status status :params params}))


;; We use AWS to store conversation exports whcih took a long time to compute.
;; These exports are set to expire automatically.
;; The number of days before expiry should be stored in env variable :export-expiry-days.
;; This value is used to compute the expiry of the exports mongo collection as well.

(defn aws-cred [darwin]
  (-> darwin :config :aws))

(defn full-aws-path
  [darwin filename]
  (str (-> darwin :config :math-env) "/" filename))

(defn upload-to-aws
  [darwin filename]
  (s3/put-object (aws-cred darwin)
                 :bucket-name "polis-datadump"
                 :key (full-aws-path darwin filename)
                 :file (full-path darwin filename)))

;; This will end up redirecting to the aws download link
(defn private-datadump-url
  [darwin filename zinvite]
  (private-url darwin
               (str "datadump/results?filename=" filename "&conversation_id=" zinvite)))

;(defn public-datadump-url
;  [darwin filename zinvite]
;  (public-url darwin (str "dataExport/results?filename=" filename "&conversation_id=" zinvite)))


(defn send-email-notification-via-polis-api!
  [darwin filename {:keys [zinvite email]}]
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
  [darwin filename params]
  (log/info "Completed export computation for filename" filename "params:" (with-out-str (str params)))
  (upload-to-aws darwin filename)
  (notify-mongo darwin filename "complete" params)
  (when (:email params) (send-email-notification-via-polis-api! darwin filename params)))


(defn handle-timedout-datadump!
  [darwin filename compute-chan params]
  (log/info "Timed out on datadump computation for filename" filename "params:" (with-out-str (str params)) ". Starting async lifecycle.")
  ;; First let mongo know we're working on it
  (notify-mongo darwin filename "processing" params)
  ;; Start a go routine, which upon completion of the computation loads the data to
  ;; aws and updates the mongo
  (go (when-let [_ (<! compute-chan)]
        (handle-completion! (aws-cred darwin) filename params))))

(defn- ->double
  "Try to parse a decimal number as double; return nil if not possible."
  [x]
  (try (Double/parseDouble x)
       (catch Exception e nil)))

(defn generate-aws-url!
  "Generate a presigned url from amazon for the given filename. Optionally set an expiration in hours (defaulting to the number
  sourced from env variable :download-link-expiration-hours)."
  ([darwin filename expiration]
   ;; XXX more env/env stuff
   (let [expiration (-> expiration time/days time/from-now)]
     (str (s3/generate-presigned-url (aws-cred darwin) "polis-datadump" (full-aws-path darwin filename) expiration))))
  ([darwin filename]
   (let [expiration (-> darwin :config :export :expiry-days)]
     (generate-aws-url! darwin filename expiration))))


;; What follows is the guts of our responding and computing.

;; We try to respond as soon as possible to the request.
;; If the computation takes too long, we respond with a 202 and a Location pointing to a status url.
;; When that url is pinged, it responds a 200 saying to check back later if it's not done.
;; If the computation is complete, it responds with a 201, and a url at which the results can be downloaded.

;; A more detailed outline of what this looks like in code is as follows:

;; get export params
;;   * notify-mongo (:started)
;;   * start computing
;;   * complete:
;;       * go:
;;            * upload-aws
;;            * notify-mongo (:complete)
;;       * response 200
;;   * timeout
;;       * notify-mongo (:processing)
;;       * response 202
;;       * go:
;;            * complete:
;;                 * upload-aws
;;                 * notify-mongo (:complete)
;; get export filename
;;   * not ready
;;       * 404 not there
;;   * ready
;;       * proxy aws file
;; get status filename
;;   * check status
;;   * done:
;;       * respond 201
;;       * link for download
;;   * pending
;;       * send link for download.


;; General helpers..

(def respond-404
  {:status 404
   :headers {"Content-Type" "text/plain"}
   :body "Unknown, incomplete or expired conversation export"})


;; Requests for exported files in aws.

(defn redirect-to-aws-url
  "Creates a redirection response, which redirects to the aws download link."
  [darwin filename]
  (response/redirect
    (generate-aws-url! darwin filename)))


(defn filename-request-handler
  "Given aws-creds, returns a function handler function which responds to requests for an existing file on AWS."
  [darwin {:keys [params] :as request}]
  (let [{:keys [filename zinvite]} params]
    (if (= (get (get-export-status darwin filename zinvite) "status") "complete")
      ;; Have to think about the security repercussions here. Would be nice if we could stream this and never
      ;; expose the link here. XXX
      (redirect-to-aws-url darwin filename)
      respond-404)))


;; Couple helpful things for below

(defn get-status-location-url
  [darwin filename zinvite]
  (private-url darwin (str "datadump/status?filename=" filename "&conversation_id=" zinvite)))

(defn check-back-response
  ([darwin filename zinvite status]
   (let [status-url (get-status-location-url darwin filename zinvite)]
     {:status  status
      :headers {"Content-Type" "text/plain"
                "Location" status-url}
      :body    (str "Request is processing, but cannot be returned now. "
                    "Please visit the url in the \"Location\" header (" status-url ") to check back on the status.")}))
  ([darwin filename zinvite] (check-back-response darwin filename zinvite 202)))


;; Requests for checking the status of a computation

(defn complete-response
  [darwin filename zinvite]
  (let [url (private-datadump-url darwin filename zinvite)]
    {:status  201
     :headers {"Content-Type" "text/plain"
               "Location"     url}
     :body    (str "Export is complete. Download at the Location url specified in the header (" url ")")}))

(defn get-datadump-status-handler
  [darwin {:keys [params] :as request}]
  (let [{:keys [filename zinvite]} params]
    (case (-> (get-export-status darwin filename zinvite) (get "status"))
      ("pending" "started" "processing") (check-back-response darwin filename zinvite 200)
      "complete"                         (complete-response darwin filename zinvite)
      ;; In case we don't match, 404
      respond-404)))


;; Top level; either run and return the computation results, or set things up for a 202-lifecycle to be
;; completed down the road.

(defn run-datadump
  "Based on params this actually runs the export-conversation computation."
  [darwin filename params]
  (log/info "Params for run-datadump are:" (with-out-str (prn params)))
  (try
    (let [;; The dissoc is just a vague security measure
          request-params (-> params
                             (dissoc :env-overrides)
                             (assoc :filename (full-path darwin filename)))]
      (export/export-conversation darwin request-params)
      ;; Return truthy :done token
      :done)
    (catch Exception e
      (log/error "Error with datadump computation:" (with-out-str (prn params)))
      (.printStackTrace e)
      {:exception e})))




;; The filename is actually pretty iportant.
;; It should be unique between different expors, as is used as the identifying key for the aws buckets, mongo
;; tracking and as part of the API requests.

(defn generate-filename
  "Generates a filename based on request-params"
  [{:keys [zinvite at-date format] :as request-params}]
  (let [last-updated (or at-date (System/currentTimeMillis))
        ext (case format :excel "xlsx" :csv "zip")
        filename (str "polis-export-" zinvite "-" last-updated "." ext)]
    filename))



;; The following is really just a bunch of parameter parsing stuff.
;; Tihs could all possibly be interwoven with the config component as well.

(defn- ->long
  "Try to parse as an integer as long; return nil if not possible."
  [x]
  (try (Long/parseLong x)
       (catch Exception e nil)))

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

(def allowed-params #{:filename :zinvite :at-date :format :email :timeout})

;; And finally, our param parser.

(defn parsed-params
  "Parses the params for a request, occording to parsers."
  [params]
  ;(log/info "Here are the params:" params)
  (reduce
    (fn [m [k v]]
      ;; Don't really need this if we have params instead of query params, but whateves
      (let [k (keyword k)]
        (if (allowed-params k)
          (assoc m k ((or (parsers k) identity) v))
          m)))
    {}
    params))

(defn get-datadump-handler
  "Main handler function; Attempts to return a datadump file within within a set amount of time, and if it can't, will
  respond with a 202, and set up a process for obtaining the results once they're done."
  [darwin {:keys [params] :as request}]
  (let [params (parsed-params params)
        ;; Check validity of params here
        _ (log/info "Handling datadump request with params:" (with-out-str (prn params)))
        filename (generate-filename params)
        datadump (async/thread (run-datadump darwin filename params))
        timeout (async/timeout (or (:timeout parsed-params) 29000))
        [done? _] (async/alts!! [datadump timeout])]
    (cond
      ;; We'll try to catch all exceptions before this
      (:exception done?)
      {:status 500 :headers {"Content-Type" "text/plain"} :body "There was an error processing this request."}
      ;; Any other truthy value means we have successful computation
      done?
      (do
        (handle-completion! darwin filename params)
        (assoc-in (response/file-response (full-path darwin filename))
                  [:headers "Content-Disposition"]
                  (str "attachment; filename=" \" filename \")))
      ;; Otherwise, the timeout hit, and we should trigger the check back later lifecycle
      :else
      (do
        (handle-timedout-datadump! darwin filename datadump params)
        (check-back-response darwin filename (:zinvite params))))))



;; Route everything together, build handlers, etc

(defn routes [darwin]
  ["/" {"ping"      ping-handler
        "datadump/" {"get"     (partial get-datadump-handler darwin)
                     "status"  (partial get-datadump-status-handler darwin)
                     "results" (partial filename-request-handler darwin)}}])

(defn make-handler [darwin]
  (bidi.ring/make-handler (routes darwin)))

;; securitay ;; move env variables to config component
(defn authenticated? [darwin name pass]
  (let [config (-> darwin :config :darwin)]
    (and (= name (:server-auth-username config))
         (= pass (:server-auth-pass config)))))

;; For added security, wade through this crap...

; Need to add to component config
;(def valid-remote-addresses (-> env/env :valid-remote-addresses (clojure.string/split #"\s+")))
;(defn restrict-remote-address
;  [handler]
;  (fn [request]
;    (if-not (valid-remote-addresses (:remote-addr request))
;      {:status 401 :header {"Content-Type" "text/plain"} :body "Domain restriction is activated, and you are not requesting from an authorized domain"}
;      (handler request))))

;; Again, base on config component  XXX
;(defn redirect-http-to-https-if-required
;  [handler]
;  ;; Can cast this as bool? XXX
;  ;(if (= (:export-server-require-ssl env/env) "true")
;  (if false
;    (do
;      ;; Should be using log
;      (log/info "SERVER_REQUIRE_SSL set to true; using redirect middleware.")
;      (-> handler ssl/wrap-forwarded-scheme ssl/wrap-ssl-redirect))
;    (do
;      (log/info "SERVER_REQUIRE_SSL unset; ssl not being required.")
;      handler)))


(defn log-requests
  [handler]
  (fn [request]
    (log/info "Darwin request received:" (utils/hash-map-subset request [:request-method :uri :query-string :remote-addr]))
    (handler request)))

(defrecord Darwin [config postgres mongo conversation-manager handler]
  component/Lifecycle
  (start [component]
    (let [handler
          (-> (make-handler component)
              ring.keyword-params/wrap-keyword-params
              ring.params/wrap-params
              (auth/wrap-basic-authentication (partial authenticated? component))
              log-requests)]
      ;redirect-http-to-https-if-required
      ;restrict-remote-access
      (assoc component :handler handler)))
  (stop [component]
    component))


(defn create-darwin
  []
  (map->Darwin {}))



;; TODO / Thoughts


;; # Implement

;; Set up env variables in server: :export-aws-link-expiration, :export-expiry-days, :server-port,
;; :export-server-auth-username, :export-server-auth-pass, :aws-access-key, :aws-secret-key

;; Error handling on export fail...

;; Should do validations on request params and return 4xx if anything is fishy


;; # Check

;; auth middleware [x]

;; Require zinvite from server request for downloaded conv, so that it's easier to secure (test)

;; ssl redirects and such


;; # Ideas

;; See if it's possible to proxy/mask the aws signed url instead of redirect

;; Mmm... how to delete pending submissions that get canceled due to a server restart? maybe we keep track of
;; a global of what processing are running and for which exports, and look at that when we get a status
;; request

;; Auto retry conversations that somehow fail based on heart beat?


:ok

