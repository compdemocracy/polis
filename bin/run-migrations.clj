#!/usr/bin/env bb

(require '[babashka.pods :as pods]
         '[babashka.deps :as deps]
         '[clojure.pprint :as pp]
         '[clojure.tools.cli :as cli]
         '[clojure.java.io :as io]
         '[clojure.string :as string])

(pods/load-pod 'org.babashka/postgresql "0.0.1")
(deps/add-deps '{:deps {honeysql/honeysql {:mvn/version "1.0.444"}}})

(require '[pod.babashka.postgresql :as pg]
         '[honeysql.core :as hsql]
         '[honeysql.helpers :as hsqlh])



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


(defn insert!
  [table values]
  (execute! {:insert-into table
             :values values}))

;(hsqlh/values [{:a "this" :b 4}])

;(-> (hsqlh/insert-into :migrations)
    ;(hsqlh/values [{:a "this" :b 3}])
    ;(hsql/format))
      


;; get about the migration business

(def migrations-path "server/postgres/migrations/")

(defn sql-file?
  [file]
  (re-matches #".*\.sql" (str file)))

(defn table-exists?
  [table-name]
  (->
    (execute! {:select [:*]
               :from [:information_schema.tables]
               :where [:= :table_name (name table-name)]})
    (not-empty)
    (boolean)))

;(table-exists? :migrations)
;(table-exists? :fish)

(defn remember-tx-migration! [name]
  (insert! :migrations
           [{:name name
             :completed_at (System/currentTimeMillis)}]))

;; Make sure we have a migrations table, which is basically just a list of filenames which have been
;; transacted, as well as datetime
(when-not (table-exists? :migrations)
  (execute-sql!
    ["CREATE TABLE migrations
     (name VARCHAR(999) NOT NULL,
      completed_at BIGINT NOT NULL);"]))

(defn process-mig-file! [mig-file]
  (let [mig-file (io/file mig-file)
        name (.getName mig-file)]
    (println "Processing migration file" name)
    (execute-sql! [(slurp mig-file)])
    (remember-tx-migration! name)))

(defn migration-files []
  (->> (.listFiles (io/file migrations-path))
       (remove #(.isDirectory %))
       (filter sql-file?)
       (sort)))

(defn remove-past-migrations
  [mig-files]
  (let [past-migrations
        (->> 
          (execute! {:select [:name]
                     :from [:migrations]})
          (map :migrations/name)
          (set))]
    (remove (comp past-migrations #(.getName %))
            mig-files)))

(defn new-migration-files
  []
  (remove-past-migrations (migration-files)))

;(remove-past-migrations (migration-files))

;(.getName (io/file "server/postgres/migrations/000000_initial.sql"))
;(.getParent (io/file "server/postgres/migrations/000000_initial.sql"))

(when-not (table-exists? :conversations)
  (process-mig-file! "server/postgres/migrations/000000_initial.sql")
  (remember-tx-migration! "000000_initial.sql"))

(when-not (table-exists? :pwreset_tokens)
  (process-mig-file! "server/postgres/migrations/000001_update_pwreset_table.sql")
  (remember-tx-migration! "000001_update_pwreset_table.sql"))

(def past-migrations
  (execute! {:select [:*]
             :from [:migrations]}))

(let [mig-files (new-migration-files)]
  (if (empty? mig-files)
    (println "No new migrations to run")
    (doseq [mig-file (new-migration-files)]
      (process-mig-file! mig-file))))


