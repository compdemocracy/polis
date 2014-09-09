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


(defn -main
  []
  (->
    (get-intercom-users)
    (->>
      (sort-by #(get % "created_at"))
      (map #(vector (get % "created_at") (user-id-str %))))
    (pp/wide-pp)))


