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
  []
  (->
    (client/get "https://api.intercom.io/users"
                {:accept :json
                 :basic-auth ["nb5hla8s" (env/env :intercom-api-key)]})
    :body
    (ch/parse-string)
    (->>
      (into {}))))


(defn -main
  []
  (->>
    (get-intercom-users)
    (get "users")
    (pp/wide-pp)))

