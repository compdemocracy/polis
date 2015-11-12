(ns polismath.darwin.email
  (:require [polismath.components.env :as env]
            [clj-http.client :as client]))

(defn send-email!
  "Simple email helper for sending email via mailgun based on config, from, to, subject, text and optionally html"
  ([config {:keys [from to subject text html] :as params}]
   (let [{:keys [api-key url]} (:email config)]
     (try
       (client/post url
                    {:basic-auth ["api" api-key]
                     :query-params params})
       (catch Exception e (.printStackTrace e)))))
  ([config from to subject text html] (send-email! config {:from from :to to :subject subject :text text :html html}))
  ([config from to subject text] (send-email! config {:from from :to to :subject subject :text text})))

