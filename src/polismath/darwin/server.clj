;; Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.darwin.server)
;  (:require [polismath.darwin.export :as export]
;            ;; XXX Deprecate; use component config directly
;            [polismath.components.env :as env]
;            [polismath.components.db :as db]
;            [polismath.darwin.email :as email]
;            [clojure.core.async :as async :refer [chan >!! <!! >! <! go]]
;            [clojure.tools.logging :as log]
;            [ring.component.jetty :refer [jetty-server]]
;            [ring.util.response :as response]
;            [ring.middleware.params :as ring.params]
;            [ring.middleware.ssl :as ssl]
;            [ring.middleware.keyword-params :as ring.keyword-params]
;            [ring.middleware.basic-authentication :as auth :refer [wrap-basic-authentication]]
;            [bidi.bidi :as bidi]
;            [com.stuartsierra.component :as component]
;            [monger.collection :as mc]
;            [hiccup.core :as hiccup]
;            [amazonica.aws.s3 :as s3]
;            [clj-time.core :as time]))
;
;
;;; First we'll just set up some basic helpers and settings/variables we'll need.
;;; We'll really want to move these to the configuration component when that exists. XXX
;
;(def tmp-dir (or (:export-temp-dir env/env) "/tmp/")) ; XXX
;(defn full-path [filename] (str tmp-dir filename))
;
;(def private-app-url-base (or (:export-server-url-base env/env) "http://localhost:3000"))
;(def public-app-url-base "https://pol.is/api/v3")
;(defn private-url
;  [& path]
;  (apply str private-app-url-base "/" path))
;
;(defn public-url
;  [& path]
;  (apply str public-app-url-base "/" path))
;
;
;;; A ping handler will just be for debugging purposes
;
;(defn ping-handler
;  "Simple ping handler. Returns response with edn representation of the request as the body.
;  For testing purposes."
;  [request]
;  {:status  200
;   :headers {"Content-Type" "text/plain"}
;   :body (with-out-str (clojure.pprint/pprint request))})
;
;
;;; The filename is actually pretty iportant.
;;; It should be unique between different expors, as is used as the identifying key for the aws buckets, mongo
;;; tracking and as part of the API requests.
;
;(defn generate-filename
;  "Generates a filename based on request-params"
;  [{:keys [zinvite at-date format] :as request-params}]
;  (let [last-updated (or at-date (System/currentTimeMillis))
;        ext (case format :excel "xlsx" :csv "zip")
;        filename (str "polis-export-" zinvite "-" last-updated "." ext)]
;    filename))
;
;
;;; The following is really just a bunch of parameter parsing stuff.
;;; Tihs could all possibly be interwoven with the config component as well.
;
;(defn ->double
;  "Try to parse a decimal number as double; return nil if not possible."
;  [x]
;  (try (Double/parseDouble x)
;       (catch Exception e nil)))
;
;(defn ->long
;  "Try to parse as an integer as long; return nil if not possible."
;  [x]
;  (try (Long/parseLong x)
;       (catch Exception e nil)))
;
;(defn between? [a b x]
;  (and x (< a x) (> b x)))
;
;(defn parse-and-validate-timeout
;  [x]
;  (let [x (try (Long/parseLong x)
;               (catch Exception e (throw (Exception. "Invalid timeout value"))))]
;    (assert (and x (< 0 x) (>= 29000 x)) "Invalid timout value")
;    x))
;
;(def parsers {:at-date ->long
;              :format  keyword
;              :timeout parse-and-validate-timeout})
;
;(def allowed-params #{:filename :zinvite :at-date :format :email :timeout})
;
;(defn parsed-params
;  "Parses the params for a request, occording to parsers."
;  [params]
;  ;(log/info "Here are the params:" params)
;  (reduce
;    (fn [m [k v]]
;      ;; Don't really need this if we have params instead of query params, but whateves
;      (let [k (keyword k)]
;        (if (allowed-params k)
;            (assoc m k ((or (parsers k) identity) v))
;            m)))
;    {}
;    params))
;
;
;;; We use mongo to persists the status of our exports, and data needed for downloading from AWS.
;;; Here, we're setting up basic mongo read and write helpers.
;
;(defn update-export-status
;  [filename zinvite document]
;  (mc/update (db/mongo-db (:mongolab-uri env/env))
;             (db/mongo-collection-name "exports")
;             {:filename filename :zinvite zinvite}
;             (db/format-for-mongo identity (assoc document
;                                                  :filename filename
;                                                  :zinvite zinvite
;                                                  :lastupdate (System/currentTimeMillis)))
;             {:upsert true}))
;
;(defn get-export-status
;  [filename zinvite]
;  (mc/find-one (db/mongo-db (:mongolab-uri env/env))
;               (db/mongo-collection-name "exports")
;               {:filename filename :zinvite zinvite}))
;
;(defn notify-mongo
;  [filename status params]
;  (update-export-status filename (:zinvite params) {:status status :params params}))
;
;
;;; We use AWS to store conversation exports whcih took a long time to compute.
;;; These exports are set to expire automatically.
;;; The number of days before expiry should be stored in env variable :export-expiry-days.
;;; This value is used to compute the expiry of the exports mongo collection as well.
;
;;; move to component; uncomment on commit XXX
;(def aws-cred {:access-key (env/env :aws-access-key)
;               :secret-key (env/env :aws-secret-key)})
;
;(defn full-aws-path
;  [filename]
;  (str (:math-env env/env) "/" filename))
;
;(defn upload-to-aws
;  [aws-cred filename]
;  (s3/put-object aws-cred
;                 :bucket-name "polis-datadump"
;                 :key (full-aws-path filename)
;                 :file (full-path filename)))
;
;;; This will end up redirecting to the aws download link
;(defn private-datadump-url
;  [filename zinvite]
;  (private-url (str "datadump/results?filename=" filename "&conversation_id=" zinvite)))
;
;(defn public-datadump-url
;  [filename zinvite]
;  (public-url (str "dataExport/results?filename=" filename "&conversation_id=" zinvite)))
;
;;; Email notification of completion
;
;(defn hiccup-to-plain-text-dispatch
;  [hiccup-or-string]
;  (if (string? hiccup-or-string)
;    :type/string
;    (first hiccup-or-string)))
;
;(defmulti hiccup-to-plain-text
;  "Converts hiccup data to plain text."
;  {:arglists '([hiccup])}
;  hiccup-to-plain-text-dispatch)
;
;(defmethod hiccup-to-plain-text :default
;  [[tag & args]]
;  (let [args (if (map? (first args)) (rest args) args)]
;    (clojure.string/join "" (map hiccup-to-plain-text args))))
;
;(defmethod hiccup-to-plain-text :type/string
;  ;; This one is a little hacky... should probaby do this a different way
;  [string]
;  string)
;
;(defmethod hiccup-to-plain-text :p
;  [[tag & args]]
;  (let [args (if (map? (first args)) (rest args) args)]
;    (str (clojure.string/join "" (map hiccup-to-plain-text args)) "\n\n")))
;
;(defmethod hiccup-to-plain-text :a
;  ;; Should add metadata about what should happen with :a (href or innner)
;  [[tag attrs & args]]
;  (:href attrs))
;
;(defmethod hiccup-to-plain-text :br
;  [tag & args]
;  "\n")
;
;(defn completion-email-text
;  [zinvite download-url]
;  (let [conv-url (str "pol.is/" zinvite)
;        polis-link [:a {:href "pol.is"} "pol.is"]]
;    [:html
;     [:p "Greetings"]
;     [:p "You created a data export for " polis-link
;         " conversation " [:a {:href conv-url} conv-url] " that has just completed. "
;         "You can download the results for this conversation at the following url:"]
;     [:p [:a {:href download-url} download-url]]
;     [:p "Please let us know if you have any questons about the data."]
;     [:p "Thanks for using " polis-link "!"]
;     [:p "Christopher Small" [:br] "Chief Data Scientist"]]))
;
;(defn send-email-notification!
;  [filename params]
;  (let [zinvite (:zinvite params)
;        download-url (public-datadump-url filename zinvite)
;        email-hiccup (completion-email-text zinvite download-url)]
;    (email/send-email!
;      (:chris-email env/env)
;      (:email params)
;      (str "Data export for pol.is conversation pol.is/" zinvite)
;      (hiccup-to-plain-text email-hiccup)
;      (hiccup/html email-hiccup))))
;
;(defn handle-completion!
;  [aws-cred filename params]
;  (log/info "Completed export computation for filename" filename "params:" (with-out-str (str params)))
;  (upload-to-aws aws-cred filename)
;  (notify-mongo filename "complete" params)
;  (when (:email params) (send-email-notification! filename params)))
;
;(defn handle-timedout-datadump!
;  [aws-cred filename compute-chan params]
;  (log/info "Timed out on datadump computation for filename" filename "params:" (with-out-str (str params)) ". Starting async lifecycle.")
;  ;; First let mongo know we're working on it
;  (notify-mongo filename "processing" params)
;  ;; Start a go routine, which upon completion of the computation loads the data to
;  ;; aws and updates the mongo
;  (go (when-let [late-result (<! compute-chan)]
;        (handle-completion! aws-cred filename params))))
;
;(defn generate-aws-url!
;  "Generate a presigned url from amazon for the given filename. Optionally set an expiration in hours (defaulting to the number
;  sourced from env variable :download-link-expiration-hours)."
;  ([aws-cred filename expiration]
;   ;; XXX more env/env stuff
;   (let [expiration (-> expiration time/hours time/from-now)]
;     (str (s3/generate-presigned-url aws-cred "polis-datadump" (full-aws-path filename) expiration))))
;  ([aws-cred filename]
;   (let [expiration (->double (:export-aws-link-expiration-hours env/env))]
;     (generate-aws-url! aws-cred filename expiration))))
;
;;(let [filename "polis-export-6sc6vt-1445837850044.zip"]
;  ;(str (s3/generate-presigned-url aws-cred "polis-datadump" (full-aws-path filename) 3)))
;
;;; What follows is the guts of our responding and computing.
;
;;; We try to respond as soon as possible to the request.
;;; If the computation takes too long, we respond with a 202 and a Location pointing to a status url.
;;; When that url is pinged, it responds a 200 saying to check back later if it's not done.
;;; If the computation is complete, it responds with a 201, and a url at which the results can be downloaded.
;
;;; A more detailed outline of what this looks like in code is as follows:
;
;;; get export params
;;;   * notify-mongo (:started)
;;;   * start computing
;;;   * complete:
;;;       * go:
;;;            * upload-aws
;;;            * notify-mongo (:complete)
;;;       * response 200
;;;   * timeout
;;;       * notify-mongo (:processing)
;;;       * response 202
;;;       * go:
;;;            * complete:
;;;                 * upload-aws
;;;                 * notify-mongo (:complete)
;;; get export filename
;;;   * not ready
;;;       * 404 not there
;;;   * ready
;;;       * proxy aws file
;;; get status filename
;;;   * check status
;;;   * done:
;;;       * respond 201
;;;       * link for download
;;;   * pending
;;;       * send link for download.
;
;
;;; General helpers..
;
;(def respond-404
;  {:status 404
;   :headers {"Content-Type" "text/plain"}
;   :body "Unknown, incomplete or expired conversation export"})
;
;
;;; Requests for exported files in aws.
;
;(defn redirect-to-aws-url
;  "Creates a redirection response, which redirects to the aws download link."
;  [aws-cred filename]
;  (response/redirect
;    (generate-aws-url! aws-cred filename)))
;
;(defn make-filename-request-handler
;  "Given aws-creds, returns a function handler function which responds to requests for an existing file on AWS."
;  [aws-cred]
;  (fn [{:keys [params] :as request}]
;    (let [{:keys [filename zinvite]} params]
;      (if (= (get (get-export-status filename zinvite) "status") "complete")
;        ;; Have to think about the security repercussions here. Would be nice if we could stream this and never
;        ;; expose the link here. XXX
;        (redirect-to-aws-url aws-cred filename)
;        respond-404))))
;
;
;;; Couple helpful things for below
;
;(defn get-status-location-url
;  [filename zinvite]
;  (private-url (str "datadump/status?filename=" filename "&conversation_id=" zinvite)))
;
;(defn check-back-response
;  ([filename zinvite status]
;   (let [status-url (get-status-location-url filename zinvite)]
;     {:status  status
;      :headers {"Content-Type" "text/plain"
;                "Location" status-url}
;      :body    (str "Request is processing, but cannot be returned now. "
;                    "Please visit the url in the \"Location\" header (" status-url ") to check back on the status.")}))
;  ([filename zinvite] (check-back-response filename zinvite 202)))
;
;
;;; Requests for checking the status of a computation
;
;(defn complete-response
;  [filename zinvite]
;  (let [url (private-datadump-url filename zinvite)]
;    {:status  201
;     :headers {"Content-Type" "text/plain"
;               "Location"     url}
;     :body    (str "Export is complete. Download at the Location url specified in the header (" url ")")}))
;
;(defn get-datadump-status-handler
;  [{:keys [params] :as request}]
;  (let [{:keys [filename zinvite]} params]
;    (case (-> (get-export-status filename zinvite) (get "status"))
;      ("pending" "started" "processing") (check-back-response filename zinvite 200)
;      "complete"                         (complete-response filename zinvite)
;      ;; In case we don't match, 404
;      respond-404)))
;
;
;;; Top level; either run and return the computation results, or set things up for a 202-lifecycle to be
;;; completed down the road.
;
;(defn run-datadump
;  "Based on params this actually runs the export-conversation computation."
;  [filename params]
;  (log/info "Params for run-datadump are:" (with-out-str (prn params)))
;  (try
;    (let [;; The dissoc is just a vague security measure
;          request-params (-> params
;                             (dissoc :env-overrides)
;                             (assoc :filename (full-path filename)))]
;      (export/export-conversation request-params)
;      ;; Return truthy :done token
;      :done)
;    (catch Exception e
;      (log/error "Error with datadump computation:" (with-out-str (prn params)))
;      (.printStackTrace e)
;      {:exception e})))
;
;(defn get-datadump-handler
;  "Main handler function; Attempts to return a datadump file within within a set amount of time, and if it can't, will
;  respond with a 202, and set up a process for obtaining the results once they're done."
;  [{:keys [params] :as request}]
;  (let [params (parsed-params params)
;        ;; Check validity of params here
;        _ (log/info "Handling datadump request with params:" (with-out-str (prn params)))
;        filename (generate-filename params)
;        datadump (async/thread (run-datadump filename params))
;        timeout (async/timeout (or (:timeout parsed-params) 29000))
;        [done? _] (async/alts!! [datadump timeout])]
;    (cond
;      ;; We'll try to catch all exceptions before this
;      (:exception done?)
;      {:status 500 :headers {"Content-Type" "text/plain"} :body "There was an error processing this request."}
;      ;; Any other truthy value means we have successful computation
;      done?
;      (do
;        (handle-completion! aws-cred filename params)
;        (assoc-in (response/file-response (full-path filename))
;                  [:headers "Content-Disposition"]
;                  (str "attachment; filename=" \" filename \")))
;      ;; Otherwise, the timeout hit, and we should trigger the check back later lifecycle
;      :else
;      (do
;        (handle-timedout-datadump! aws-cred filename datadump params)
;        (check-back-response filename (:zinvite params))))))
;
;
;;; Route everything together, build handlers, etc
;
;(def routes
;  ["/" {"ping"      ping-handler
;        "datadump/" {"get"     get-datadump-handler
;                     "status"  get-datadump-status-handler
;                     "results" (make-filename-request-handler aws-cred)}}])
;
;(def handler
;  (bidi.ring/make-handler routes))
;
;
;;; securitay ;; move env variables to config component
;(defn authenticated? [name pass]
;  (and (= name (:export-server-auth-username env/env))
;       (= pass (:export-server-auth-pass env/env))))
;
;;; Again, base on config component  XXX
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
;
;;; Should add to component
;(def valid-remote-addresses (-> env/env :valid-remote-addresses (clojure.string/split #"\s+")))
;(defn restrict-remote-address
;  [handler]
;  (fn [request]
;    (if-not (valid-remote-addresses (:remote-addr request))
;      {:status 401 :header {"Content-Type" "text/plain"} :body "Domain restriction is activated, and you are not requesting from an authorized domain"}
;      (handler request))))
;
;
;(def app
;  {:handler
;   (-> handler
;       ring.keyword-params/wrap-keyword-params
;       ring.params/wrap-params
;       (auth/wrap-basic-authentication authenticated?))})
;       ;redirect-http-to-https-if-required
;       ;restrict-remote-access
;
;
;(defn get-port
;  [default]
;  (or (try
;        ;; Component XXX
;        (Double/parseDouble (:port env/env))
;        (catch Exception e default))))
;
;;; Enter component:
;;; This is a bit of a hack right now, since the rest of our system is not in components... But whatevs. XXX
;;; In short we're creating a reference to hold our server, and setting up functions for starting, stopping and
;;; reloading that reference.
;
;(def ^:dynamic *jetty-settings*
;  {:app app
;   :port (get-port 3000)
;   ;; Not sure exactly what this is doing; maybe leave out XXX
;   :client-auth :need})
;
;
;
;(defonce http-server
;  (jetty-server *jetty-settings*))
;
;(defn start-server!
;  []
;  (alter-var-root #'http-server component/start))
;
;(defn stop-server!
;  []
;  (alter-var-root #'http-server component/stop))
;
;(defn reset-server!
;  []
;  (stop-server!)
;  (def http-server (jetty-server *jetty-settings*))
;  (start-server!))
;
;
;;; Main function; just start the component
;
;(defn -main []
;  (start-server!))


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

