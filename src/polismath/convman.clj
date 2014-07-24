(ns polismath.convman
  (:require [clojure.core.async :as async :refer [>!! <!! >! <! chan go]]))


(defn drain!
  "Given core.async chan c, return lazy-seq of queued messages which terminates as
  soon as the channel is empty"
  [c]
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


(defprotocol IManager
  (enqueue [this message])
  (ping [this]))


(defrecord Manager [queue conv]
  IManager
  (enqueue [_ message]
    (go (>! queue message)))
  (ping [_]
    (send conv identity)))


(defn queued-agent [& {:keys [buffer update-fn] :or {:buffer 1000000}}]
  (let [c (chan buffer)
        a (agent {:sid [] :val []})]
    ; Set up the queue
    (add-watch
      conv
      :update-conv
      (fn [k r o n]
        (let [queued (drain! c)]
          (when-not (empty? queued)
            (send a update-fn queued)))))
    (Manager. c a)))


(defn -main []
  (println "starting")
  (let [c (chan 100)]
    ; First, add some data to our channel
    (doseq [x (range 10)]
      (>!! c x))
    (println "here we go" (into [] (drain! c)))
    ; end of let; ready to shutdown
    (println "done")))


