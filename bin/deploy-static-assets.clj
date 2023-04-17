#!/usr/bin/env bb

;; To use this script, you will need to install babashka: https://github.com/babashka/babashka#installation
;; If you have homebrew/linuxbrew installed, you can use:
;;
;;     brew install borkdude/brew/babashka
;;
;; Before deploying, use `make PROD start-rebuild` to get the system running, then from another shell, run
;;
;;     docker cp polis-prod-file-server-1:/app/build build
;;
;; to copy over all of the static assets from the container to local directory.
;; Next you will have to make sure that you have the AWS environment variables set.
;;
;; Then you should be able to run:
;;
;;     ./bin/deploy-static-assets.clj --bucket preprod.pol.is --dist-path build
;;
;; This deploys to the `preprod.pol.is` bucket.
;; To deploy to the production `pol.is` bucket, use instead `--bucket pol.is`.

(require '[babashka.pods :as pods]
         '[babashka.deps :as deps]
         '[babashka.process :as process]
         '[clojure.core.async :as async]
         '[clojure.pprint :as pp]
         '[clojure.tools.cli :as cli]
         '[clojure.java.io :as io]
         '[clojure.string :as string]
         '[cheshire.core :as json])

(pods/load-pod 'org.babashka/aws "0.0.6")
(deps/add-deps '{:deps {honeysql/honeysql {:mvn/version "1.0.444"}}})

(require '[pod.babashka.aws :as aws]
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
;(->> (:Contents (aws/invoke s3-client {:op :ListObjects :request {:Bucket "preprod.pol.is"}}))
     ;(map :Key)
     ;(filter #(re-matches #".*\.headersJson" %)))
;(->> (:Contents (aws/invoke s3-client {:op :ListObjects :request {:Bucket "preprod.pol.is"}}))
     ;(filter #(re-matches #".*/fonts/.*" (:Key %))))

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
   ;; technically don't need these since being explicitly set for everything but the fonts files, but doesn't
   ;; hurt as a backup
   :html  "text/html; charset=UTF-8"
   :js    "application/javascript"
   :css   "text/css; charset=UTF-8"})

(def cache-buster-seconds 31536000);
(def cache-buster (format "no-transform,public,max-age=%s,s-maxage=%s" cache-buster-seconds cache-buster-seconds))

;(json/decode (slurp (io/file "build/embed.html.headersJson"))
             ;(comp keyword #(clojure.string/replace % #"-" "")))

(defn headers-json-data
  [file]
  (let [data (json/decode (slurp file)
               (comp keyword #(clojure.string/replace % #"-" "")))]
    (select-keys data [:ContentType :CacheControl :ContentEncoding])))

(defn relative-path
  "Return the relative path of file file to the base path"
  [path-base file]
  (let [path-base (cond-> path-base
                    (not= (last path-base) \/) (str "/"))
        full-path (str file)]
    (string/replace full-path path-base "")))

(defn file-upload-request
  "Return an aws s3 upload request given bucket name, deploy spec, and file"
  [bucket base-path file]
  (let [headers-file (io/file (str file ".headersJson"))]
    (merge
      {:Bucket bucket
       :Body (io/input-stream (io/file file))
       :Key (relative-path base-path file)
       :ACL "public-read"}
      (if (.exists headers-file)
        (headers-json-data headers-file)
        ;; This should just be for the fonts files, which are the only that don't have an explicit headersJson
        ;; file; assuming caching
        {:ContentType (-> file file-extension ext->content-type)
         :CacheControl cache-buster}))))

;(file-seq (io/file "build"))

(defn upload-requests [bucket path]
  (->> (file-seq (io/file path))
       (filter #(and (.isFile %) ;; exclude subdirectories
                     (not (re-matches #".*\.headersJson" (str %))))) ;; omit, headersJson, since processed separately
       (map (partial file-upload-request bucket path))))

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
  (println "Processing request:" request)
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

(defn responses [bucket path]
  (let [requests (upload-requests bucket path)
        output-chan (async/chan concurrent-requests)]
    (async/pipeline-blocking concurrent-requests
                             output-chan
                             (map process-deploy)
                             (async/to-chan requests))
    (async/<!! (async/into [] output-chan))))

(defn errors [responses]
  (remove (comp :ETag second)
          responses))

(defn -main [& {:as opts-map :strs [--bucket --dist-path]}]
  (let [bucket (get-bucket --bucket)
        _ (println "Deploying static assets to bucket:" bucket)
        responses (responses bucket (or --dist-path "build"))
        errors (errors responses)]
    (if (not-empty errors)
      (do
        (println "Problem processing" (count errors) "requests")
        (doseq [[request response] errors]
          (println "Problem processing request:" request)
          (pp/pprint response)))
      (println "Deploy completed without error."))))


(apply -main *command-line-args*)

;; QED

