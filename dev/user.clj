(ns user
  (:require [polismath.runner :as runner]
            [polismath.system :as system]
            [polismath.meta.microscope :as microscope]
            [polismath.conv-man :as conv-man]
            [polismath.math.conversation :as conv]
            [polismath.components.postgres :as postgres]
            [clojure.core.matrix :as matrix]
            [clojure.core.async :as async :refer [>! <! >!! <!! go go-loop thread]]
            [environ.core :as env]
            [taoensso.timbre :as log]))


(defn get-conv
  "For this to work, we need something like `load-conv! that doesn't just load the conversation locally, but assocs in
  to conv man as well."
  [{:keys [zid zinvite]}]
  (let [zid (or zid (postgres/get-zid-from-zinvite (:postgres runner/system) zinvite))]
    (-> runner/system :conversation-manager :conversations deref (get zid))))

(defn load-conv
  [{:as args :keys [zid zinvite]}]
  (let [zid (or zid (postgres/get-zid-from-zinvite (:postgres runner/system) zinvite))]
    (conv-man/load-or-init (:conversation-manager runner/system) zid)))


;; Can toggle between do and comment here for refiring entire file
;(do
(comment
  ;; Run one of these to interactively test out a particular system or subsystem
  ;(runner/run! system/base-system)
  ;(runner/run! system/task-system)
  ;(runner/run! system/darwin-system)
  (runner/run! system/full-system)
  (runner/stop!)

  ;; Execute this to run pure math/util tests
  (require '[runner :as test-runner])
  ;; Rerun the tests once runner has been required by executing this
  (test-runner/-main)


  ;; Setting up load and interactive testing for a specific conversation
  (def args {:zid 15228})
  (def conv (load-conv args))

  ;; Testing out updates via the pure conv-update function
  (let [updated-conv (conv/conv-update conv [{:zid 15228 :pid 0 :tid 0 :vote 2.0 :created (System/currentTimeMillis)}])
        _ (log/info "First update")
        updated-conv' (conv/conv-update updated-conv [{:zid 15228 :pid 0 :tid 0 :vote -1 :created (System/currentTimeMillis)}])
        _ (log/info "Second update")]
    (log/info "Conv keys:" (keys conv))
    (log/info "Updated conv keys:" (keys updated-conv))
    (log/info "Previous conv key:" (boolean (:conv updated-conv)))
    (log/info "Previous conv key:" (boolean (:conv (:conv updated-conv'))))
    (:subgroup-clusters updated-conv'))
    ;(:repness updated-conv'))

  ;(get-conv args)
  (-> runner/system :conversation-manager :conversations deref)


  ;; Playing with core.async parallelism
  (defn dowork [size]
    (doseq [i (range size)]
      (reduce + (range i))))

  (let [kill-chan (async/promise-chan)
        parallelism 4
        work-size 30000]
    (doseq [_ (range parallelism)]
      (thread
        (dowork work-size))))

  :end)
