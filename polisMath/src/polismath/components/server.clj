;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.components.server
  (:require
    ;; XXX Deprecate; use component config directly
    [clojure.core.async :as async :refer [chan >!! <!! >! <! go]]
    [taoensso.timbre :as log]

    [ring.adapter.jetty :as jetty]
    [com.stuartsierra.component :as component]

    [polismath.components.env :as env]
    [ring.util.response :as response]
    [ring.middleware.params :as ring.params]
    [ring.middleware.ssl :as ssl]
    [ring.middleware.keyword-params :as ring.keyword-params]
    [ring.middleware.basic-authentication :as auth :refer [wrap-basic-authentication]]
    [bidi.bidi :as bidi]))


(defn healthcheck-handler
  [_]
  {:status 200
   :headers {}
   :body "All systems go!"})

(defn wrap-handler
  "This wraps a handler such that requested for /healthcheck"
  [handler]
  (fn [{:as request :keys [uri]}]
    (log/debug "wrap-handler called for request" uri)
    (if (= uri "/healthcheck")
      (healthcheck-handler request)
      (handler request))))


;; TODO! If we need a healthcheck server again, strip out old stuff from the darwin server (:app below etc)

(defrecord Server
  [config opts app jetty-server]
  component/Lifecycle
  (start [component]
    (log/info ">> Starting server component with config:" (:server config))
    (let [wrapped-handler (wrap-handler (:handler app))
          jetty-server (jetty/run-jetty wrapped-handler
                                        (merge {:join? false :port 8080}
                                               (:server config)
                                               opts))]
      (.start jetty-server)
      (assoc component :jetty-server jetty-server)))
  (stop [component]
    (log/info "<< Stopping server component")
    (try
      (.stop jetty-server)
      (catch Exception e
        (log/error e "Unable to stop server!")))
    component))


(defn create-server
  ;; Default handler just return the healthcheck response always
  ([opts]
   (let [opts (merge {:app {:handler healthcheck-handler}}
                     opts)]
     (map->Server opts)))
  ([]
   (create-server {})))
