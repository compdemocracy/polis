#!/usr/bin/env bb

(require '[babashka.pods :as pods]
         '[babashka.deps :as deps]
         '[babashka.process :as process]
         '[clojure.core.async :as async]
         '[clojure.pprint :as pp]
         '[clojure.tools.cli :as cli]
         '[clojure.java.io :as io]
         '[clojure.string :as string])

(pods/load-pod 'org.babashka/postgresql "0.0.1")
(pods/load-pod 'org.babashka/aws "0.0.5")
(deps/add-deps '{:deps {honeysql/honeysql {:mvn/version "1.0.444"}}})

(require '[pod.babashka.postgresql :as pg]
         '[honeysql.core :as hsql]
         '[honeysql.helpers :as hsqlh]
         '[pod.babashka.aws :as aws])

;; Should move this to arg parsing if and when available
(def region (or (System/getenv "AWS_REGION")
                "us-east-1"))

(def s3-client
  "The s3 client for this process"
  (aws/client {:api :s3 :region region}))

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
  ;{:path "dist/"
   ;:pattern #".*\.html"}
  ;(io/file "dist/404.html"))


(defn try-int [s]
  (try
    (Long/parseLong s)
    (catch Throwable t
      nil)))

;(mapv try-int (string/split "2021_3_20_4_32_16" #"_"))

(defn latest-version [cache-dir]
  (->> (.listFiles (io/file cache-dir))
       (sort-by #(mapv try-int (string/split % #"_")))
       (last)))

;(latest-version "participation-client/dist/cached")

(defn spec-requests
  [bucket {:as spec :keys [path cached-path pattern ContentEncoding]}]
  (let [file (io/file (or path cached-path))]
    (cond
      cached-path
      (->> (latest-version file)
           (file-seq)
           (filter #(and (.isFile %) ;; exclude subdirectories
                         (or (not pattern) (re-matches pattern (str %))))) ;; apply pattern if present
           (map (partial file-upload-request bucket spec)))
      (and path (.isDirectory file))
      (->> (file-seq file)
           (filter #(and (.isFile %) ;; exclude subdirectories
                         (or (not pattern) (re-matches pattern (str %))))) ;; apply pattern if present
           (map (partial file-upload-request bucket spec)))
      (and path (.isFile file))
      [(file-upload-request bucket spec file)])))

;(spec-requests "preprod.pol.is"
   ;{:cached-path "client-admin/dist/cached"
    ;:pattern #".*\.js"
    ;:ContentEncoding "gzip"})

;(spec-requests "preprod.pol.is"
   ;{:cached-path "client-participation/dist/cached"
    ;:pattern #".*/css/.*\.css"})

;(spec-requests "preprod.pol.is"
  ;{:path "dist/"
   ;:pattern #".*\.html"})

;(spec-requests "preprod.pol.is"
  ;{:cached-path "dist/cached/"
   ;:ContentEncoding "gzip"})

;(re-matches #".*\.(html|svg)" "test.svg")
(def deploy-specs
  [
   ;; client admin
   {:cached-path "client-admin/dist/cached"
    ;; <version>/js/* -> cached/<version>/js/**
    :pattern #".*\.js"
    :ContentEncoding "gzip"}
   {:path "client-admin/dist/"
    :pattern #".*\.html"}

   ;; participation client files
   {:path "client-participation/dist/"
    :pattern #".*\.html"}
   {:path "client-participation/dist/"
    :pattern #"twitterAuthReturn\.html"
    :ContentEncoding "gzip"}
   {:path "client-participation/dist/"
    :pattern #"embedPreprod\.js"}
   {:path "client-participation/dist/"
    :pattern #"embed\.js"}
   {:cached-path "client-participation/dist/cached"
    :pattern #".*/css/.*\.css"}
   {:cached-path "client-participation/dist/cached"
    :pattern #".*\.(html|svg)"}
   {:cached-path "client-participation/dist/cached"
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

(println "arg" (pr-str (first *command-line-args*)))
(def bucket
  (case (first *command-line-args*)
    "PRODUCTION" "pol.is"
    ;; else
    "preprod.pol.is"))


(def responses
  (let [requests (mapcat (partial spec-requests bucket)
                         deploy-specs)
        output-chan (async/chan concurrent-requests)]
    (async/pipeline-blocking concurrent-requests
                             output-chan
                             (map process-deploy)
                             (async/to-chan requests))
    (async/<!! (async/into [] output-chan))))

(def errors
  (remove (comp :ETag second)
          responses))

(if (not-empty errors)
  (do
    (println "Problem processing" (count errors) "requests")
    (doseq [[request response] errors]
      (println "Problem processing request:" request)
      (pp/pprint response)))
  (println "Deploy completed without error."))


;; QED

