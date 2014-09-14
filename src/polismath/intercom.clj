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


(defn update-icuser
  [params]
  (->>
    params
    (ch/generate-string)
    (assoc intercom-http-params :body)
    (client/post "https://api.intercom.io/users")))


(declare users conversations votes participants)

(ko/defentity users
  (ko/pk :uid)
  (ko/entity-fields :uid :hname :username :email :is_owner :created :plan)
  (ko/has-many conversations)
  (ko/has-many votes))

(ko/defentity conversations
  (ko/pk :zid)
  (ko/entity-fields :zid :owner)
  (ko/has-many votes)
  (ko/belongs-to users (:fk :owner)))

(ko/defentity votes
  (ko/entity-fields :zid :pid :tid :vote :created)
  (ko/belongs-to participants (:fk :pid))
  (ko/belongs-to conversations (:fk :zid)))

(ko/defentity participants
  (ko/entity-fields :pid :uid :zid :created)
  (ko/belongs-to users (:fk :uid))
  (ko/belongs-to conversations (:fk :zid)))


(def get-db-users
  (->
    (ko/select* users)
    (ko/fields :uid :hname :username :email :is_owner :created :plan)))


(def get-db-users-with-stats
  (->
    get-db-users
    (ko/fields :owned_convs.avg_n_ptpts
               :owned_convs.n_owned_convs
               :ptpt_summary.n_ptptd_convs)
    ; Join summary stats of owned conversations
    (ko/join :left
      [(ko/subselect
         conversations
         (ko/fields :owner)
         ; Join participant count summaries per conv
         (ko/join
           [(ko/subselect
              participants
              (ko/fields :zid)
              (ko/aggregate (count (ko/raw "DISTINCT pid")) :n_ptpts :zid))
            ; as conv_summary
            :conv_summary]
           (= :conv_summary.zid :zid))
         ; Average participant counts, and count number of conversations
         (ko/aggregate (avg :conv_summary.n_ptpts) :avg_n_ptpts)
         (ko/aggregate (count (ko/raw "DISTINCT conversations.zid")) :n_owned_convs)
         (ko/group :owner))
       ; as owned_convs
       :owned_convs]
      (= :owned_convs.owner :uid))
    ; Join summary stats on participation
    (ko/join
      :left
      [(ko/subselect
         participants
         (ko/fields :uid)
         (ko/aggregate (count (ko/raw "DISTINCT zid")) :n_ptptd_convs :uid))
       :ptpt_summary]
      (= :ptpt_summary.uid :uid))))


(defn get-db-users-by-uid
  [db-spec uids]
  (kdb/with-db db-spec
    (->
      get-db-users-with-stats
      (ko/where (in :uid uids))
      (ko/select))))


(defn get-db-users-by-email
  [db-spec emails]
  (kdb/with-db db-spec
    (->
      get-db-users-with-stats
      (ko/where (in :email emails))
      (ko/select))))

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
         [:custom_attributes
            (pc/fn->
              (hash-map-subset
                [:avg_n_ptpts :n_owned_convs :n_ptptd_convs]))]
         [:remote_created_at
            #(/ (:created %) 1000)]]))))



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


