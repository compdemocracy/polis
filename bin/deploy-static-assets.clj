#!/usr/bin/env bb

;; This script is a utility for deploying static web assets to AWS S3, as an alternative to the `file-server`
;; container.
;;
;; To use this script, you will need to [install babashka](https://github.com/babashka/babashka#installation)
;; and the AWS CLI. If you have homebrew/linuxbrew installed, you can accomplish both with:
;;
;;     brew install borkdude/brew/babashka awscli
;;
;; Before deploying, use
;;
;;     make build-web-assets
;;
;; to build and extract the web assets into the `build` directory.
;;
;; You may choose to run with either with `PROD` settings specified in your `prod.env` file
;; (`make PROD build-web-assets`), or with custom settings explicitly for deploying web assets
;; (e.g. a `prod-web-assets.env`) file with `make ENV_FILE=prod-web-assets.env extract-web-assets`).
;;
;; Next you will have to make sure that you have the AWS environment variables set to authenticate the AWS
;; CLI. There are quite a few ways to do this, and we recommend following AWS documentation for this. Possible
;; routes include using `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` environment variables (not
;; recommended, since non-privileged processes can read these environment variables), setting these values in
;; your `~/.aws/config` file under a profile (either `default` or a custom profile if you set the
;; `AWS_PROFILE` environment variable), with a combination of the `~/.aws/config` file and the
;; `~/.aws/credentials` file, or with `aws sso login` if you are using AWS SSO (a.k.a. IAM Identity Center,
;; which is the recommended pathway by AWS for organizational human user authentication). This script just
;; calls out to the `aws` cli, so if it properly authenticated/authorized and functioning, this script should work.
;;
;; Once all this is set up, you should be able to run (e.g.):
;;
;;     ./bin/deploy-static-assets.clj --bucket my-aws-s3-bucket-name --dist-path build


(require '[babashka.pods :as pods]
         '[babashka.deps :as deps]
         '[babashka.process :as process]
         '[clojure.core.async :as async]
         '[clojure.pprint :as pp]
         '[clojure.tools.cli :as cli]
         '[clojure.java.io :as io]
         '[clojure.string :as string]
         '[cheshire.core :as json])



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
      {:file file
       :Bucket bucket
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


;; synchonous execution
(defn process-deploy
  "Execute AWS S3 request, and return result"
  [{:as request :keys [Bucket Key ACL ContentType CacheControl ContentEncoding file]}]
  (println "Processing request:" request)
  [request
   (process/sh "aws" "s3" "cp"
               ;"--metadata" (json/encode (dissoc request :file :Bucket :Body :Key))
               ;"--acl" ACL
               "--content-type" ContentType
               "--content-encoding" ContentEncoding
               "--metadata-directive" "REPLACE"
               (str file)
               (str "s3://" Bucket "/" Key))])


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
    ;; pipeline pushes the request objects through the (map process-deploy) transducer in parallel, and
    ;; collects results in the output chan
    (async/pipeline-blocking concurrent-requests
                             output-chan
                             (map process-deploy)
                             (async/to-chan requests))
    (async/<!! (async/into [] output-chan))))

(defn errors [responses]
  (remove (comp (partial = 0) :exit second) ; remove 0 exit status (0 is success)
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

