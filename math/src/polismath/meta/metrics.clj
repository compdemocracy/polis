;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.meta.metrics
  (:require [clojure.tools.logging :as log]
            [com.stuartsierra.component :as component]))


(defn- make-socket
  "Make a datagram socket; optional port parameter is the local port for the socket. If ommitted (or if nil is passed),
  the Java implementation will pick some available port and bind it."
  ([] (new java.net.DatagramSocket))
  ([port] (if port (new java.net.DatagramSocket port) (make-socket))))

(defrecord MetricSender [config send-socket]
  component/Lifecycle
  (start [component]
    (log/info "Starting metric sender")
    (let [send-socket (make-socket (-> config :meta :graphite :local-port))]
      (assoc component :send-socket send-socket)))
  (stop [component]
    (log/info "Closing metric sender")
    (.close send-socket)
    (assoc component :send-socket nil)))

(defn- get-config
  [metric-sender]
  (-> metric-sender :config :meta :graphite))

(defn- send-data
  [metric-sender data]
  (let [send-socket (:send-socket metric-sender)
        {:keys [hostname remote-port]} (get-config metric-sender)
        ipaddress (java.net.InetAddress/getByName hostname)
        send-packet (new java.net.DatagramPacket (.getBytes data) (.length data) ipaddress remote-port)]
    (.send send-socket send-packet)))

(defn- make-send-string
  "All metric keys are prepended with 'math.prod.'"
  [api-key values]
  (str api-key ".math.prod." (partial clojure.string/join " " values) \n))

(defn- send-metric-values
  [metric-sender values]
  (let [{:keys [api-key hostname remote-port]} (get-config metric-sender)]
    (when (and api-key hostname)  ; Only send metrics if properly configured
      (log/info "sending metric data " values " to " hostname ":" remote-port)
      (send-data metric-sender
                 (make-send-string api-key
                                   values)))))

;; ## Public API

(defn send-metric
  "Sends metric using metric sender, with optional timestamp attribute"
  ([metric-sender name value timestamp]
   (send-metric-values metric-sender [name value timestamp]))
  ([metric-sender name value]
   (send-metric-values metric-sender [name value])))

(defmacro meter
  "Macro wrapping send-metric which runs a computation and sends the metrics to graphitedb"
  [metric-sender metric-name & expr]
  `(let [start# (System/currentTimeMillis)
         ret# ~@expr
         end# (System/currentTimeMillis)
         duration# (- end# start#)]
     (send-metric ~metric-sender ~metric-name duration# end#)
     (log/debug (str end# " " ~metric-name " " duration# " millis"))
     ret#))

:ok

