(ns polismath.server
  (:require [polismath.export :as export]
            [ring.component.jetty :refer [jetty-server]]
            [ring.util.response :as response]
            [ring.middleware.params :as ring.params]
            [ring.middleware.keyword-params :as ring.keyword-params]
            [clojure.core.async :as async :refer [chan >!! <!! >! <! go]]
            [com.stuartsierra.component :as component]
            [plumbing.core :as pc]
            [polismath.env :as env]
            [polismath.db :as db]
            [monger.core :as mg]
            [monger.collection :as mc]
            [amazonica.core :as aws]
            [amazonica.aws.s3 :as s3]
            [amazonica.aws.s3transfer :as s3transfer]
            [clj-time.core :as time]
            [bidi.bidi :as bidi]
            [bidi.ring]))


;; First we'll just set up some basic helpers and settings/variables we'll need.
;; We'll really want to move these to the configuration component when that exists. XXX

(def tmp-dir "/tmp/")
(defn full-path [filename] (str tmp-dir filename))

(def app-url-base "https://localhost:3000")
;(def app-url-base "https://polismath-aux.heroku.com")
(defn full-url
  [& path]
  (apply str app-url-base "/" path))


;; A ping handler will just be for debugging purposes

(defn ping-handler
  "Simple ping handler. Returns response with edn representation of the request as the body.
  For testing purposes."
  [request]
  {:status  202
   :headers {"Content-Type" "text/plain" "Location" "chhhdkjdf"}
   :params {:stuff "the x y"}
   :body (with-out-str (clojure.pprint/pprint request))})


;; The filename is actually pretty iportant.
;; It should be unique between different expors, as is used as the identifying key for the aws buckets, mongo
;; tracking and as part of the API requests.

(defn generate-filename
  "Generates a filename based on request-params"
  [{:keys [zid zinvite at-date format] :as request-params}]
  (let [zinvite (or zinvite (export/get-zinvite-from-zid zid))
        last-updated (or at-date (System/currentTimeMillis))
        ext (case format :excel "xlsx" :csv "zip")
        path (str "/tmp/polis-export-" zinvite "-" last-updated "." ext)]
    path))


;; The following is really just a bunch of parameter parsing stuff.
;; Tihs could all possibly be interwoven with the config component as well.

(defn ->int
  "Try to parse as an integer; return nil if not possible."
  [x]
  (try (Integer/parseInt x)
       (catch Exception e nil)))

(def parsers {:zid ->int
              :zinvite ->int})

(def allowed-params #{:filename :zid :zinvite :at-date :format})

(defn parsed-params
  "Parses the params for a request, occording to parsers."
  [params]
  (reduce
    (fn [m [k v]] (if (allowed-params k)
                    (assoc m k ((parsers k) v))
                    m))
    {}
    params))


;; We use mongo to persists the status of our exports, and data needed for downloading from AWS.
;; Here, we're setting up basic mongo read and write helpers.

(defn update-export-status
  [filename zinvite document]
  (mc/insert (db/mongo-db (:env/env :mongolab-uri))
             (db/mongo-collection-name "exports")
             {:filename filename :zinvite zinvite}
             (db/format-for-mongo identity (assoc document
                                                  :filename filename
                                                  :zinvite zinvite
                                                  :lastupdate (System/currentTimeMillis)))
             {:upsert true}))

(defn get-export-status
  [filename zinvite]
  (mc/find-one (db/mongo-db (:env/env :mongolab-uri))
               (db/mongo-collection-name "exports")
               {:filename filename :zinvite zinvite}))

(defn notify-mongo
  [filename status params]
  (update-export-status filename (:zinvite params) {:status status :params params}))


;; We use AWS to store conversation exports whcih took a long time to compute.
;; These exports are set to expire automatically.
;; The number of days before expiry should be stored in env variable :export-expiry-days.
;; This value is used to compute the expiry of the exports mongo collection as well.

;; move to component; uncomment on commit XXX
;(def aws-cred {:access-key (env/env :aws-access-key)
               ;:secret-key (env/env :aws-secret-key)})

(defn full-aws-path
  [filename]
  (str (:math-env env/env) "/" filename))

(defn upload-to-aws
  [aws-cred filename]
  (s3/put-object aws-cred
                 :bucket-name "polis-datadump"
                 :key (full-aws-path filename)
                 :file (full-path filename)))

(defn handle-completion!
  [aws-cred filename params]
  (upload-to-aws aws-cred filename)
  (notify-mongo filename "complete" params))

(defn handle-timedout-datadump!
  [aws-cred filename compute-chan params]
  ;; First let mongo know we're working on it
  (notify-mongo filename "processing" params)
  ;; Start a go routine, which upon completion of the computation loads the data to
  ;; aws and updates the mongo
  (go (when-let [late-result (<! compute-chan)]
        (handle-completion! aws-cred filename params))))

(defn generate-aws-url!
  "Generate a presigned url from amazon for the given filename. Optionally set an expiration in hours (defaulting to the number
  sourced from env variable :download-link-expiration."
  ([aws-cred filename expiration]
   ;; XXX more env/env stuff
   (let [expiration (-> expiration time/hours time/from-now)]
     (s3/generate-presigned-url aws-cred "polis-datadump" (full-aws-path filename) expiration)))
  ([aws-cred filename]
   (let [expiration (->int (:download-link-expiration env/env))]
     (generate-aws-url! aws-cred filename expiration))))


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
  [aws-cred filename]
  (response/redirect
     (generate-aws-url! aws-cred filename)))

(defn make-filename-request-handler
  "Given aws-creds, returns a function handler function which responds to requests for an existing file on AWS."
  [aws-cred]
  (fn [{:keys [params] :as request}]
    (let [{:keys [filename zinvite]} params]
      (if (= (get (get-export-status filename zinvite) "status") "complete")
        ;; Have to think about the security repercussions here. Would be nice if we could stream this and never
        ;; expose the link here. XXX
        (redirect-to-aws-url aws-cred filename)
        respond-404))))


;; Requests for checking the status of a computation

(defn get-datadump-url
  [filename zinvite]
  (full-url (str "datadump/results?filename=" filename "&zinvite=" zinvite)))

(defn complete-response
  [filename zinvite]
  {:status  201
   :headers {"Content-Type" "text/plain"
             "Location"     (get-datadump-url filename zinvite)}
   :body    "Export is complete. Download at the Location url specified in the header"})

(defn get-datadump-status-handler
  [{:keys [params] :as request}]
  (let [{:keys [filename zinvite]} params]
    (case (-> (get-export-status filename zinvite) (get "status"))
      ("pending" "started" "processing") (check-back-response filename zinvite 200)
      "complete"                         (complete-response filename zinvite)
      ;; In case we don't match, 404
      respond-404)))


;; Top level; either run and return the computation results, or set things up for a 202-lifecycle to be
;; completed down the road.

(defn get-status-location-url
  [filename zinvite]
  (full-url (str "datadump/status?filename=" filename "&zinvite=" zinvite)))

(defn check-back-response
  ([filename zinvite status]
   {:status  status
    :headers {"Content-Type" "text/plain"
              "Location" (get-status-location-url filename zinvite)}
    :body    "Request is processing, but cannot be returned now. Please check back later with the same request url."})
  ([filename zinvite] (check-back-response filename zinvite 202)))

(defn run-datadump
   "Based on params this actually runs the export-conversation computation."
  [filename {:keys [params] :as request}]
  (let [params (parsed-params params)
        ;; The dissoc is just a vague security measure
        request-params (-> request
                           :params
                           (dissoc :env-overrides)
                           (assoc :filename (full-path filename)))]
    (export/export-conversation request-params)
    filename))

(defn get-datadump-handler
  "Main handler function; Attempts to return a datadump file within within a set amount of time, and if it can't, will
  respond with a 202, and set up a process for obtaining the results once they're done."
  [{:keys [params] :as request}]
  (let [filename (generate-filename request)
        datadump (async/thread (run-datadump filename request))
        timeout (async/timeout 2000)
        [done? _] (async/alts!! [datadump timeout])]
    (if done?
      (do
        (handle-completion! aws-cred filename params)
        ;(response/file-response "6sc6vt-export.zip") ; XXX
        (response/file-response (full-path filename)))
      (do
        (handle-timedout-datadump! aws-cred datadump filename params)
        (check-back-response filename (:zinvite params))))))


;; Route everything together, build handlers, etc

(def routes
  ["/" {"ping"     ping-handler
        "datadump" {""        get-datadump-handler
                    "status"  get-datadump-status-handler
                    "results" (make-filename-request-handler aws-cred)}}])

(def handler
  (bidi.ring/make-handler routes))

(def app
  {:handler
   (-> handler
       ring.keyword-params/wrap-keyword-params
       ring.params/wrap-params
       )})

(defn get-port
  [default]
  (or (try
        (Double/parseDouble (:server-port env/env))
        (catch Exception e default))))

;; Enter component:
;; This is a bit of a hack right now, since the rest of our system is not in components... But whatevs. XXX
;; In short we're creating a reference to hold our server, and setting up functions for starting, stopping and
;; reloading that reference.

(defonce http-server
  (jetty-server {:app app, :port (get-port 3000)}))

(defn start-server!
  []
  (alter-var-root #'http-server component/start))

(defn stop-server!
  []
  (alter-var-root #'http-server component/stop))

(defn reset-server!
  []
  (stop-server!)
  (def http-server (jetty-server {:app app :port (get-port 3000)}))
  (start-server!))


;; Main function; just start the component

(defn main []
  (start-server!)
  (stop-server!)
  )

;; For sketching and REPLING

(comment
  (require '[clj-http.client :as client])

  (reset-server!)
  (-> (client/post "http://localhost:3000/ping" {:form-params {:q "foo, bar"}})
      (dissoc :body)
      clojure.pprint/pprint)
  )


;; TODO / Thoughts

;; Mmm... how to delete pending submissions that get canceled due to a server restart? maybe we keep track of
;; a global of what processing are running and for which exports, and look at that when we get a status
;; request

;; Auto retry conversations that somehow fail based on heart beat?

;; Require zinvite from ser request for downloaded conv, so that it's easier to secure

