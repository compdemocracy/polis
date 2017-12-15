;; Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.meta.notify
  (:require [clj-http.client :as client]))


;; Keep track of the type of notifications sent, and when they were sent, so you can avoid spamming.
;; Maps from error code to time last sent in millis.
(def team-notifications (atom {}))


(defn send-team-notification [subject body]
  (try
    (let [darwin-config (-> darwin :config)
          response (client/post (str (:webserver-url darwin-config) "/notifyTeam")
                       {:form-params {:webserver_username (:webserver-username darwin-config)
                                      :webserver_pass (:webserver-pass darwin-config)
                                      :subject subject
                                      :body body}
                        :content-type :json
                        :throw-entire-message? true})]
      (log/info "notifyTeam response:\n" (with-out-str (clojure.pprint/pprint response))))
    (catch Exception e
      (log/error e "failed to notifyTeam:\n"))))

(defn notify-team [error-code subject body]
  (let [now (quot (System/currentTimeMillis) 1000)
        min-wait (* 60 60 1000)]
    (if (or
          (not (contains? team-notifications error-code))
          (>= now (+ min-wait (get team-notifications error-code))))
      (do
        (send-team-notification subject body)
        (swap! team-notifications (fn [old] (assoc old error-code now)))))))
            
:ok
