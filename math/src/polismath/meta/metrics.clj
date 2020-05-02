;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.meta.metrics
  (:require [clojure.tools.logging :as log]
            [com.stuartsierra.component :as component]))


;; Should maybe make this component depend upon mongo so that it handles both metrics that get to mongo and
;; those sent to graphitedb. Either that or we should rename the component and namespace graphitedb...

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
  "All keys are name keys are prepended with 'math.<math-env>.'..."
  [math-env api-key values]
  (str api-key ".math." math-env "." (partial clojure.string/join " " values) \n))

(defn- send-metric-values
  [metric-sender values]
  (let [{:keys [api-key hostname remote-port]} (get-config metric-sender)]
    (log/info "sending metric data " values " to " hostname ":" remote-port)
    (send-data metric-sender
               (make-send-string (-> metric-sender :config :math-env)
                                 api-key
                                 values))))

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

;; It looks like we can optionally get responses from graphitedb? We're not using that capability for now
;; though.

;(defn receive-data [receive-socket]
  ;(let [receive-data (byte-array 1024),
       ;receive-packet (new java.net.DatagramPacket receive-data 1024)]
  ;(.receive receive-socket receive-packet)
  ;(new java.lang.String (.getData receive-packet) 0 (.getLength receive-packet))))


;(defn make-receive [receive-port]
  ;(let [receive-socket (make-socket receive-port)]
    ;(fn [] (receive-data receive-socket))))

:ok

