;; Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.meta.notify
  (:require [clj-http.client :as client]
            [taoensso.timbre :as log]))


;; Keep track of the type of notifications sent, and when they were sent, so you can avoid spamming.
;; Maps from message type to a list of timestamps. If there are more than N timestamps within T seconds, it prevents sending. Timestamps older than T seconds will be cleared.
(def team-notifications-per-message-type-throttle (atom {}))
;; Maps from zid,message-type to time last sent in millis.
(def team-notifications-per-convo (atom {}))


(def throttle-count 5) ; number of messages of message-type that can be sent during a throttle-time amount of time
(def throttle-time (* 60 60 1000))
(def min-wait (* 60 60 1000))

(defn send-team-notification [config subject body]
  (try
    (let [response (client/post (str (:webserver-url config) "/notifyTeam")
                       {:form-params {:webserver_username (:webserver-username config)
                                      :webserver_pass (:webserver-pass config)
                                      :subject subject
                                      :body body}
                        :content-type :json
                        :throw-entire-message? true})]
      (log/info "notifyTeam response:\n" (with-out-str (clojure.pprint/pprint response))))
    (catch Exception e
      (log/error e "failed to notifyTeam:\n"))))


(defn error-message-body
  [error]
  (let [{:as error-map :keys [cause via trace]} (Throwable->map error)]
    (str "Cause: " (:cause error-map) "\n"
         "Via:" (:via error-map) "\n\n"
         "Trace:\n"
         (apply str
                (for [row trace]
                  (str "    " row "\n"))))))

(defn notify-team [config message-type zid subject body]
  (let [now (quot (System/currentTimeMillis) 1000)
        per-convo-key [zid message-type]
        oldest (- now throttle-time)
        trimmed-throttle-list (filter (fn [t] (> t oldest)) (get @team-notifications-per-message-type-throttle message-type))
        message-type-throttle-count (count trimmed-throttle-list)]
    (if (and
          (< message-type-throttle-count throttle-count) ; don't send more than 5 per hour for a given message type
          (or ; don't send more than one per zid,message-type per hour
            (not (contains? @team-notifications-per-convo per-convo-key))
            (>= now (+ min-wait (get @team-notifications-per-convo per-convo-key)))))
      (do
        (send-team-notification config subject body)
        (swap! team-notifications-per-convo (fn [old] (assoc old per-convo-key now)))
        (swap! team-notifications-per-message-type-throttle (fn [old] (assoc old message-type (conj trimmed-throttle-list now))))))))
            
:ok
