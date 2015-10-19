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

;(ns-unalias *ns* 'env)

(def tmp-dir "/tmp/")
(defn full-path [filename] (str tmp-dir filename))

(def app-url-base "https://localhost:3000")
;(def app-url-base "https://polismath-aux.heroku.com")
(defn full-url
  [& path]
  (apply str app-url-base "/" path))

(defn ping-handler
  "Simple ping handler. Returns response with edn representation of the request as the body.
  For testing purposes."
  [request]
  {:status  202
   :headers {"Content-Type" "text/plain" "Location" "chhhdkjdf"}
   :params {:stuff "the x y"}
   :body (with-out-str (clojure.pprint/pprint request))})

(defn generate-filename
  "Generates a filename"
  [{:keys [zid zinvite at-date format] :as request-params}]
  (let [zinvite (or zinvite (export/get-zinvite-from-zid zid))
        last-updated (or at-date (System/currentTimeMillis))
        ext (case format :excel "xlsx" :csv "zip")
        path (str "/tmp/polis-export-" zinvite "-" last-updated "." ext)]
    path))

;; config component => parameterization system?
(defn ->int
  [x]
  (try (Integer/parseInt x)
       (catch Exception e nil)))


(def parsers {:zid ->int
              :zinvite ->int})
(def allowed-params #{:filename :zid :zinvite :at-date :format})
(defn parsed-params
  [params]
  (reduce
    (fn [m [k v]] (if (allowed-params k)
                    (assoc m k ((parsers k) v))
                    m))
    {}
    params))

;; Mmm... how to delete pending submissions that get canceled due to a server restart? maybe we keep track of
;; a global of what processing are running and for which exports, and look at that when we get a status
;; request


(defn update-export-status
  [filename document]
  (mc/insert (db/mongo-db (:env/env :mongolab-uri))
             (db/mongo-collection-name "exports")
             {:filename filename}
             (db/format-for-mongo identity (assoc document
                                                  :filename filename
                                                  :lastupdate (System/currentTimeMillis)))
             {:upsert true}))
;(update-export-status "testfilenamedeleteme" {:status :pending})

(defn get-export-status
  [filename]
  (mc/find-one (db/mongo-db (:env/env :mongolab-uri))
               (db/mongo-collection-name "exports")
               {:filename filename}))
;(get-export-status "testfilenamedeleteme")

(defn run-datadump
  [filename {:keys [params] :as request}]
  (let [params (parsed-params params)
        ;; The dissoc is just a vague security measure
        request-params (-> request
                           :params
                           (dissoc :env-overrides)
                           (assoc :filename (full-path filename)))]
    (export/export-conversation request-params)
    filename))

;; move to component; uncomment on commit
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

(defn notify-mongo
  [filename status params]
  (update-export-status filename {:status status :params params}))

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


(defn redirect-to-aws-url
  [aws-cred filename]
  (response/redirect
    (s3/generate-presigned-url aws-cred "polis-datadump" (full-aws-path filename) (-> 1 time/hours time/from-now))))

(def respond-404
  {:status 404
   :headers {"Content-Type" "text/plain"}
   :body "Unknown, incomplete or expired conversation export"})


(defn make-filename-request-handler
  [aws-cred]
  (fn [{:keys [params] :as request}]
    (let [filename (get params :filename)]
      (if (= (get (get-export-status filename) "status") "complete")
        ;; Have to think about the security repercussions here. Would be nice if we could stream this and never
        ;; expose the link here. XXX
        (redirect-to-aws-url aws-cred filename)
        respond-404))))

(defn get-status-location-url
  [filename]
  (full-url (str "datadump/status?filename=" filename)))

(defn check-back-response
  ([filename status]
   {:status  status
    :headers {"Content-Type" "text/plain"
              "Location" (get-status-location-url filename)}
    :body    "Request is processing, but cannot be returned now. Please check back later with the same request url."})
  ([filename] (check-back-response 202)))

(defn get-datadump-url
  [filename]
  (full-url (str "datadump/results?filename=" filename)))

(defn complete-response
  [filename]
  {:status  201
   :headers {"Content-Type" "text/plain"
             "Location"     (get-datadump-url filename)}
   :body    "Export is complete. Download at the Location url specified in the header"})


(defn get-datadump-status-handler
  [{:keys [params] :as request}]
  (let [filename (:filename params)]
    (case (-> filename get-export-status (get "status"))
      ("pending" "started" "processing") (check-back-response filename 200)
      "complete"                         (complete-response filename)
      ;; In case we don't match, 404
      respond-404)))


(defn get-datadump-handler
  [{:keys [params] :as request}]
  ;(let [datadump (async/thread (Thread/sleep 3000) (big-comp))
  (let [filename (generate-filename request)
        datadump (async/thread (run-datadump filename request))
        timeout (async/timeout 2000)
        [done? _] (async/alts!! [datadump timeout])]
    (if done?
      (do
        (handle-completion! aws-cred filename params)
        (response/file-response (full-path filename)))
      (do
        (handle-timedout-datadump! aws-cred datadump filename params)
        (check-back-response filename)))))



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


(def routes
  ["/" {"ping"     ping-handler
        "datadump" {""        get-datadump-handler
                    "status"  get-datadump-status-handler
                    "results" (make-filename-request-handler aws-cred)}}])

(def handler
  (bidi.ring/make-handler routes))

   ;(response/file-response "6sc6vt-export.zip"))

(def app
  {:handler
   (-> handler
       ring.keyword-params/wrap-keyword-params
       ring.params/wrap-params
       )})

;; Enter component:
;; This is a bit of a hack right now, since the rest of our system is not in components... But whatevs.

(defn get-port
  [default]
  (or (try
        (Double/parseDouble (:server-port env/env))
        (catch Exception e default))))

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

(comment
  (require '[clj-http.client :as client])

  (reset-server!)
  (-> (client/post "http://localhost:3000/ping" {:form-params {:q "foo, bar"}})
      (dissoc :body)
      clojure.pprint/pprint)
  )


