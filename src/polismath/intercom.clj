(ns polismath.intercom
  (:require [clj-http.client :as client]
            [plumbing.core :as pc]
            [cheshire.core :as ch]
            [korma.core :as ko]
            [korma.db :as kdb]
            [environ.core :as env]
            [alex-and-georges.debug-repl :as dbr]
            [polismath.pretty-printers :as pp]))


(defn get-intercom-users
  "Get the list of users from intercom (don't want to create intercom users for users that haven't
  actually signed up"
  [& [page]]
  (let [return-data
          (->
            (or page "https://api.intercom.io/users")
            (client/get
              {:accept :json
               :basic-auth ["nb5hla8s" (env/env :intercom-api-key)]})
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


(defn -main
  []
  (let [users        (get-intercom-users)
        valid-ids    (valid-user-ids users)
        users-wo-ids (filter #(not (get % "user_id")) users)]
    ; First some nice summary stats information
    (println "Total number of users:         " (count users))
    (println "Number of users with valid ids:" (count valid-ids))
    (println "Number w/o:                    " (count users-wo-ids))
    ; Digging in deeper
    (pp/wide-pp users-wo-ids)
    (doseq [u users]
      (println (gets u ["created_at" "user_id" "remote_created_at"])))
    ))


