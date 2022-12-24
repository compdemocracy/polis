#!/usr/bin/env bb

(ns my-script)

(require '[babashka.pods :as pods]
         '[babashka.deps :as deps]
         '[babashka.process :as process]
         '[clojure.core.async :as async]
         '[clojure.pprint :as pp]
         '[clojure.tools.cli :as cli]
         '[clojure.java.io :as io]
         '[clojure.string :as string])

(pods/load-pod 'org.babashka/postgresql "0.0.7")
(pods/load-pod 'org.babashka/aws "0.0.6")
(deps/add-deps '{:deps {honeysql/honeysql {:mvn/version "1.0.444"}}})

(require '[pod.babashka.postgresql :as pg]
         '[honeysql.core :as hsql]
         '[honeysql.helpers :as hsqlh]
         '[pod.babashka.aws :as aws]
         '[pod.babashka.aws.credentials :as aws-creds])

;; Should move this to arg parsing if and when available
(def region (or (System/getenv "AWS_REGION")
                "us-east-1"))

(def creds-provider
  (aws-creds/basic-credentials-provider
    {:access-key-id (System/getenv "AWS_ACCESS_KEY")
     :secret-access-key (System/getenv "AWS_SECRET_KEY")}))

(def s3-client
  "The s3 client for this process"
  (aws/client {:api :s3 :region region :credentials-provider creds-provider}))

;; list available s3 actions
;(map first (aws/ops s3-client))

;; docs for specific action
;(aws/doc s3-client :ListObjects)
;(aws/doc s3-client :PutObject)

;; basic listing contents example
;(aws/invoke s3-client {:op :ListObjects :request {:Bucket "pol.is"}})
;(aws/invoke s3-client {:op :ListObjects :request {:Bucket "preprod.pol.is"}})

(defn file-extension [file]
  (keyword (second (re-find #"\.([a-zA-Z0-9]+)$" (str file)))))

(def ext->content-type
  "A map of extension keywords to :ContentType strings"
  {:woff  "application/x-font-woff"
   :woff2 "application/font-woff2"
   :ttf   "application/x-font-ttf"
   :otf   "application/x-font-opentype"
   :svg   "image/svg+xml"
   :eot   "application/vnd.ms-fontobject"
   :html  "text/html; charset=UTF-8"
   :js    "application/javascript"
   :css   "text/css; charset=UTF-8"})

(def cache-buster-seconds 31536000);
(def cache-buster (format "no-transform,public,max-age=%s,s-maxage=%s" cache-buster-seconds cache-buster-seconds))

(defn relative-path
  "Return the relative path of file file to the base path"
  [path-base file]
  (let [path-base (cond-> path-base
                    (not= (last path-base) \/) (str "/"))
        full-path (str file)]
    (string/replace full-path path-base "")))

;(relative-path "cached/blobs" "cached/blobs/stuff/yeah")

(defn file-upload-request
  "Return an aws s3 upload request given bucket name, deploy spec, and file"
  [bucket {:as spec :keys [path cached-path ContentEncoding]} file]
  (merge
    {:Bucket bucket
     :Body (io/input-stream (io/file file))
     :Key (str (when cached-path "cached/")
            (relative-path (or path cached-path) file))
     :ACL "public-read"
     :ContentType (-> file file-extension ext->content-type)
     :CacheControl (if cached-path cache-buster "no-cache")}
    (when ContentEncoding
      {:ContentEncoding ContentEncoding})))

;(file-upload-request
  ;"preprod.pol.is"
  ;{:path "build/"
   ;:pattern #".*\.html"}
  ;(io/file "build/404.html"))


(defn try-int [s]
  (try
    (Long/parseLong s)
    (catch Throwable t
      nil)))

;(mapv try-int (string/split "2021_3_20_4_32_16" #"_"))

(defn latest-version [cache-dir]
  (->> (.listFiles (io/file cache-dir))
       (sort-by #(mapv try-int (string/split (str %) #"_")))
       (last)))

;(latest-version "participation-client/build/cached")

(defn spec-requests
  [bucket {:as spec :keys [path cached-path pattern ContentEncoding]}]
  (try
    (let [file (io/file (or path cached-path))]
      (cond
        (not (.exists file))
        [{:processing-error (str "File " file " does not exist")
          :spec spec}]
        cached-path
        (->> (latest-version file)
             (file-seq)
             (filter #(and (.isFile %) ;; exclude subdirectories
                           (or (not pattern) (re-matches pattern (str %))))) ;; apply pattern if present
             (mapv (partial file-upload-request bucket spec)))
        (and path (.isDirectory file))
        (->> (file-seq file)
             (filter #(and (.isFile %) ;; exclude subdirectories
                           (or (not pattern) (re-matches pattern (str %))))) ;; apply pattern if present
             (mapv (partial file-upload-request bucket spec)))
        (and path (.isFile file))
        [(file-upload-request bucket spec file)]))
    (catch Throwable t
      (let [error (Throwable->map t)]
        [{:processing-error (:via error)
          :throwable t
          :spec spec}]))))

(.exists (io/file "blahblah"))

;(try 
  ;(/ 1 0)
  ;(catch Throwable t
    ;(def error t)))

;(:via (Throwable->map error))

;(spec-requests "preprod.pol.is"
   ;{:cached-path "client-admin/build/cached"
    ;:pattern #".*\.js"
    ;:ContentEncoding "gzip"})

;(spec-requests "preprod.pol.is"
   ;{:cached-path "client-participation/build/cached"
    ;:pattern #".*/css/.*\.css"})

;(spec-requests "preprod.pol.is"
  ;{:path "build/"
   ;:pattern #".*\.html"})

;(spec-requests "preprod.pol.is"
  ;{:cached-path "build/cached/"
   ;:ContentEncoding "gzip"})

;; IMPORTANT NOTE: We've been transitioning away from `dist` to `build`, so there may be some differences in
;; the paths below eventually

;(re-matches #".*\.(html|svg)" "test.svg")
(def deploy-specs
  [
   ;; client admin
   {:cached-path "client-admin/build/static"
    ;; <version>/js/* -> cached/<version>/js/**
    :pattern #".*\.js"
    :ContentEncoding "gzip"}
   {:path "client-admin/build/"
    :pattern #".*\.html"}

   ;; participation client files
   {:path "client-participation/build/"
    :pattern #".*\.html"}
   {:path "client-participation/build/"
    :pattern #"twitterAuthReturn\.html"
    :ContentEncoding "gzip"}
   {:path "client-participation/build/"
    :pattern #"embedPreprod\.js"}
   {:path "client-participation/build/"
    :pattern #"embed\.js"}
   {:cached-path "client-participation/build/cached"
    :pattern #".*/css/.*\.css"}
   {:cached-path "client-participation/build/cached"
    :pattern #".*\.(html|svg)"}
   {:cached-path "client-participation/build/cached"
    :pattern #".*/js/.*\.js"
    :ContentEncoding "gzip"}])
   
   ;; client report
   ;{:path "client-report/dest-root/**/js/**"
    ;:ContentEncoding "gzip"
    ;:CacheControl cache-buster
    ;:subdir cached-subdir}
   ;{:path "client-report/dest-root/**/*.html"}]


; Inspect how this parses to AWS S3 requests
;(pp/pprint
  ;(mapcat (partial spec-requests "preprod.pol.is") deploy-specs))

;; Check content type mappings
;(doseq [request
        ;(mapcat (partial spec-requests "preprod.pol.is") deploy-specs)]
  ;(println (:Key request) (:ContentType request)))

;; test individual request
;(spec-requests "preprod.pol.is" (nth deploy-specs 5))



;; synchonous execution

(defn process-deploy
  "Execute AWS S3 request, and return result"
  [request]
  (println "processing request" (pr-str request))
  [request (aws/invoke s3-client {:op :PutObject :request request})])

;(doseq [request (mapcat (partial spec-requests "preprod.pol.is") deploy-specs)]
  ;(println "processing request for" (:Key request))
  ;(let [response (aws/invoke s3-client {:op :PutObject :request request})]
    ;(println response))))


;; process the aws requests asynchronously with parallelism 12

(def concurrent-requests 12)

(defn get-bucket [bucket-arg]
  (case bucket-arg
    "PRODUCTION" "pol.is"
    ;; else
    ("preprod" "edge") "preprod.pol.is"
    bucket-arg))

(defn responses [bucket]
  (let [requests (mapcat (partial spec-requests bucket)
                         deploy-specs)
        errors (filter :processing-error requests)
        output-chan (async/chan concurrent-requests)]
    (if (empty? errors)
      (do
        (async/pipeline-blocking concurrent-requests
                                 output-chan
                                 (map process-deploy)
                                 (async/to-chan requests))
        (async/<!! (async/into [] output-chan)))
      (do
        (doseq [error errors]
          (println "\n‼️ Error with spec:" (:spec error))
          (println "  " (:processing-error error))
          (when (:throwable error)
            (.printStackTrace (:throwable error))))
        (println "\nAborting deploy!")
        (System/exit 1)))))

(defn errors [responses]
  (remove (comp :ETag second)
          responses))

(defn -main [& {:as opts-map :strs [--bucket]}]
  (let [bucket (get-bucket --bucket)
        _ (println "Deploying static assets to bucket:" bucket)
        responses (responses bucket)
        errors (errors responses)]
    (if (seq errors)
      (do
        (println "\n🚫 Problem processing" (count errors) "requests")
        (doseq [[request response] errors]
          (println "Problem processing request:" request)
          (pp/pprint response)))
      (println "\n✅ Deploy completed without error."))))


(apply -main *command-line-args*)

;; QED

