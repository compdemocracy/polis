(ns polismath.intercom
  (:require [clj-http.client :as client]
            [plumbing.core :as pc]
            [cheshire.core :as ch]
            [korma.core :as ko]
            [korma.db :as kdb]
            [environ.core :as env]
            [alex-and-georges.debug-repl :as dbr]
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


(defn user-id
  [user]
  (try
    (-> user
        (get "user_id")
        (Integer/parseInt))
    (catch Exception e
      nil)))


(defn user-id-str
  [user]
  (get user "user_id"))


(defn valid-user-ids
  [users]
  (->> users
       (map user-id)
       (filter identity)))


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
          [ic-key (db-key db-user)])
        [[:name              :hname]
         [:user_id           :uid]
         [:email             :email]
         [:remate_created_at #(/ (:created %) 1000)]]))))


;(update-intercom-user {:email "chris@pol.is" :remote_created_at (/ 1408088823591 1000)})

;(get (first (filter #(= "kelly.baumeister@bigfishgames.com" (get % "email")) users)) "id")
(update-intercom-user {:user_id 7546390821987
                       :remote_created_at (/ 1395873111736 1000)})

(defn -main
  []
  (let [db-spec      (poll/heroku-db-spec (env/env :database-url))
        users        (get-intercom-users)
        valid-ids    (valid-user-ids users)
        users-w-ids  (filter #(get % "user_id") users)
        users-wo-ids (filter #(not (get % "user_id")) users)]
    ; First some nice summary stats information
    (println "Total number of users:         " (count users))
    (println "Number of users with valid ids:" (count valid-ids))
    (println "Number w/o:                    " (count users-wo-ids))
    ; Getting to work...
    ; First take care of all the ones which have valid ids. These tend to be more recent.
    ; It appears that all of the users with
    (doseq [u users-w-ids]
      (println (gets u ["email"])))
    (->>
      valid-ids
      (get-db-users-by-uid db-spec))
    ; Now we deal with the ones without valid uids. For these we match with email.
    (->>
      users-wo-ids
      (map #(get % "email"))
      ((fn [emails] (println "N emails from noids:" (count emails)) emails))
      (get-db-users-by-email db-spec)
      (map :email)
      (count)
      (println "Fetched users w/o ids:"))
    ; Call it a night
    (println "Done!")))


