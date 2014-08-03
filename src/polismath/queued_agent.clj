(ns polismath.queued-agent
  (:require [clojure.core.async :as async :refer [>!! <!! >! <! chan go]]))


(defprotocol IQueuedAgent
  (enqueue [this message])
  (ping [this]))


(defrecord QueuedAgent [agent queue]
  IQueuedAgent
  (enqueue [_ message]
    (go (>! queue message)))
  (ping [_]
    (send agent identity)))


(defn drain! [c]
  (let [cc (chan 1)]
    (go (>! cc ::queue-empty))
    (letfn
      ; This fn does all the hard work, but closes over cc to avoid reconstruction
      [(drainer! [c]
         (let [[v _] (<!! (go (async/alts! [c cc] :priority true)))]
           (if (= v ::queue-empty)
             (lazy-seq [])
             (lazy-seq (cons v (drainer! c))))))]
      (drainer! c))))


(defn queued-agent [& {:keys [buffer update-fn init-fn] :or {:buffer 1000000}}]
  (let [q (chan buffer)
        a (agent (if init-fn (init-fn) {}))]
    ; Set up the queue
    (add-watch
      a
      :update-conv
      (fn [k r o n]
        (let [queued (drain! q)]
          (when-not (empty? queued)
            (send a update-fn queued)))))
    (QueuedAgent. a q)))


