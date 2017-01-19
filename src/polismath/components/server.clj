;; Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.components.server
  (:require
    ;; XXX Deprecate; use component config directly
    [clojure.core.async :as async :refer [chan >!! <!! >! <! go]]
    [clojure.tools.logging :as log]

    [ring.component.jetty :as jetty]
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
    (log/debug "uri:" uri)
    (if (= uri "/healthcheck")
      (healthcheck-handler request)
      (handler request))))

(defrecord Server
  [config opts app jetty-server]
  component/Lifecycle
  (start [component]
    (let [wrapped-handler (wrap-handler (:handler app))
          jetty-server (jetty/jetty-server (merge {:app (merge app {:handler wrapped-handler})}
                                                  (:server config)
                                                  opts))]
      (assoc component :jetty-server jetty-server)))
  (stop [component]
    (component/stop jetty-server)
    component))


(defn create-server
  ;; Default handler just return the healthcheck response always
  ([{:as opts :or {handler healthcheck-handler}}]
   (map->Server opts))
  ([]
   (create-server {})))
