(ns polismath.intercom
  (:require [clj-http.client :as client]
            [plumbing.core :as pc]
            [cheshire.core :as ch]
            [korma.core :as ko]
            [korma.db :as kdb]
            [environ.core :as env]
            [alex-and-georges.debug-repl :as dbr]
            [clojure.stacktrace :refer :all]
            [clojure.tools.logging :as log]
            [clojure.tools.trace :as tr]
            [polismath.utils :refer :all]
            [polismath.pretty-printers :as pp]
            [polismath.poller :as poll]))


(def intercom-http-params
  {:accept :json
   :basic-auth ["nb5hla8s" (env/env :intercom-api-key)]
   :content-type :json})
 

(defn get-intercom-users
  "Get the list of users from intercom (don't want to create intercom users for users that haven't
  actually signed up"
  [& [page]]
  (let [return-data
          (->
            (or page "https://api.intercom.io/users")
            (client/get intercom-http-params)
            :body
            (ch/parse-string)
            (->>
              (into {})))
        next-page (get-in return-data ["pages" "next"])
        users (get return-data "users")]
    (sort-by 
      (fn [u] (int (get u "created_at")))
      (if next-page
        (into users (get-intercom-users next-page))
        users))))


(defn gets
  "Like get, but gives a coll mapped from all the keys"
  [m ks & [not-found]]
  (mapv #(get m % not-found) ks))


(defn get-db-users-by-uid
  [db-spec uids]
  (kdb/with-db db-spec
    (ko/select
      "users"
      (ko/fields :uid :hname :username :email :is_owner :created :plan)
      (ko/where {:uid [in uids]}))))


(defn get-db-users-by-email
  [db-spec emails]
  (kdb/with-db db-spec
    (ko/select
      "users"
      (ko/fields :uid :hname :username :email :is_owner :created :plan)
      (ko/where {:email [in emails]}))))


(defn update-icuser
  [params]
  (->>
    params
    (ch/generate-string)
    (assoc intercom-http-params :body)
    (client/post "https://api.intercom.io/users")))


(defn update-icuser-from-dbuser
  [dbuser]
  (update-icuser
    (into
      {}
      (map
        (fn [[ic-key db-key]]
          [ic-key (db-key dbuser)])
        [[:name              :hname]
         [:user_id           :uid]
         [:email             :email]
         [:remote_created_at #(/ (:created %) 1000)]]))))



; Main functions:
; ===============


(defn backup-intercom-users
  "Backup intercom users to json file specified by filename arg."
  [filename]
  (let [icusers (get-intercom-users)]
    (spit filename (ch/generate-string icusers))))


(defn update-intercom-db
  "Update intercom records by grabbing existing records, and from those the corresponding PG DB records
  so tha twe have enough information to flesh out missing information."
  []
  (let [db-spec          (poll/heroku-db-spec (env/env :database-url))
        ; Get intercom users and break down by those that have id and those that don't, but have email
        icusers          (get-intercom-users)
        icusers-by-id    (filter #(get % "user_id") icusers)
        icusers-by-email (filter #(not (get % "user_id")) icusers)
        ; Get users by id, then by email for those without id, then put them all together in one collection
        dbusers-by-id    (get-db-users-by-uid db-spec
                           (map #(Integer/parseInt (get % "user_id")) icusers-by-id))
        dbusers-by-email (get-db-users-by-email db-spec
                           (map #(get % "email") icusers-by-email)) 
        all-users        (into dbusers-by-id dbusers-by-email)]
    ; First some nice summary stats information
    (println "Total number of intercom users:" (count icusers))
    (println "Number of users with valid ids:" (count icusers-by-id))
    (println "Number w/o:                    " (count icusers-by-email))
    ; Now getting to work
    (println "Now updating all user records in intercom")
    (doseq [u all-users]
      (log/info "Running update for user:" (hash-map-subset u [:uid :email :hname :created]))
      (update-icuser-from-dbuser u))
    ; Call it a night
    (println "Done!")))


