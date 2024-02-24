#!/usr/bin/env bb

(require '[babashka.pods :as pods]
         '[babashka.deps :as deps]
         '[clojure.pprint :as pp]
         '[clojure.tools.cli :as cli])

(pods/load-pod 'org.babashka/postgresql "0.0.1")
(deps/add-deps '{:deps {honeysql/honeysql {:mvn/version "1.0.444"}}})

(require '[pod.babashka.postgresql :as pg]
         '[honeysql.core :as hsql])



(def db-url
  (System/getenv "DATABASE_URL"))

(defn heroku-url-spec [db-url]
  (let [[_ user password host port db] (re-matches #"postgres://(?:(.+):(.*)@)?([^:]+)(?::(\d+))?/(.+)" db-url)]
    {:dbtype "postgresql"
     :host host
     :dbname db
     :port (or port 80)
     :user user
     :password password}))

(defn execute-sql! [args]
  (println "Executing sql:" args)
  (pg/execute!
    (heroku-url-spec (System/getenv "DATABASE_URL"))
    args))
    

;(def execute-sql!
  ;(partial pg/execute! (heroku-url-spec (System/getenv "DATABASE_URL"))))

(defn execute!
  [query-or-command]
  (execute-sql! (hsql/format query-or-command)))


(def cli-options
  [["-z" "--zid ZID" "Conversation database zid"
    :parse-fn #(Integer/parseInt %)]
   ["-Z" "--zinvite ZINVITE" "Conversation zinvite (url id)"]])

(def args (:options (cli/parse-opts *command-line-args* cli-options)))

(let [{:keys [zid zinvite]} args]
  (when-not (or zid zinvite)
    (println "You must specify either `--zid` (`-z`) or `--zinvite` (`-Z`)")
    (System/exit 1)))

(defn get-zid
  [zinvite]
  (:zinvites/zid
    (first
      (execute! {:select [:zid]
                 :from [:zinvites]
                 :where [:= :zinvite zinvite]}))))

(defn get-zid-or-exit [zinvite]
  (let [zid (get-zid zinvite)]
    (if zid
      (do
        (println "Found zid for zinvite: " zid)
        zid)
      (do
        (println "Unable to find matching zid for zinvite:" zinvite)
        (System/exit 1)))))

(def zid
  (let [{:keys [zid zinvite]} args]
    (or zid (get-zid-or-exit zinvite))))

(execute!
  {:update :conversations
   :where [:= :zid zid]
   :set {:is_active false}})

(println "Conversation archived")


