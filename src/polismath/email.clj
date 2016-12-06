(ns polismath.email
  (:require [polismath.env :as env]
            [clojure.tools.logging :as log]
            [clj-http.client :as client]))

(def ^:dynamic *mailgun-key* (:mailgun-api-key env/env))
(def ^:dynamic *mailgun-url* (:mailgun-url env/env))

(defn send-email!
  ([{:keys [from to subject text html] :as params}]
   (log/info "Sending email to:" to)
   (log/debug "  have mailgun key?" (boolean *mailgun-key*))
   (try
     (client/post *mailgun-url*
                  {:basic-auth ["api" *mailgun-key*]
                   :headers {"host" "pol.is"}
                   :query-params params})
     (catch Exception e (.printStackTrace e))))
  ([from to subject text html] (send-email! {:from from :to to :subject subject :text text :html html}))
  ([from to subject text] (send-email! {:from from :to to :subject subject :text text})))

