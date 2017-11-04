(ns user
  (:require [polismath.runner :as runner]
            [polismath.system :as system]
            [polismath.meta.microscope :as microscope]
            [polismath.conv-man :as conv-man]
            [polismath.math.conversation :as conv]
            [polismath.components.postgres :as postgres]
            [polismath.math.named-matrix :as nm]
            [honeysql.core :as honey]
            [clojure.core.matrix :as matrix]
            [clojure.core.async :as async :refer [>! <! >!! <!! go go-loop thread]]
            [environ.core :as env]
            [taoensso.timbre :as log]))


(defn get-conv
  "For this to work, we need something like `load-conv! that doesn't just load the conversation locally, but assocs in
  to conv man as well."
  [{:keys [zid zinvite]}]
  (let [zid (or zid (postgres/get-zid-from-zinvite (:postgres runner/system) zinvite))]
    (-> runner/system :conversation-manager :conversations deref (get zid) :conv)))

(defn load-conv
  [{:as args :keys [zid zinvite]}]
  (let [zid (or zid (postgres/get-zid-from-zinvite (:postgres runner/system) zinvite))]
    (conv-man/load-or-init (:conversation-manager runner/system) zid)))


;; Can toggle between do and comment here for refiring entire file
;(do
(comment
  ;; Run one of these to interactively test out a particular system or subsystem
  (runner/stop!)
  (runner/run! system/base-system {:math-env :dev})
  ;(runner/run! system/poller-system {:math-env :dev :poll-from-days-ago 0.1})
  ;(runner/run! system/task-system)
  ;(runner/run! system/task-system {:math-env :preprod :poll-from-days-ago 0.1})
  ;(runner/run! system/full-system {:math-env :preprod :poll-from-days-ago 0.1})
  ;(runner/run! system/full-system {:math-env :dev :poll-from-days-ago 0.1})
  ;(runner/run! system/full-system {:math-env :preprod})
  ;(runner/run! system/darwin-system)
  ;(runner/run! system/full-system {:poll {:poll-from-days-ago 0.1}})

  ;; Execute this to run pure math/util tests
  (require '[runner :as test-runner])
  ;; Rerun the tests once runner has been required by executing this
  (test-runner/-main)


  ;; Setting up load and interactive testing for a specific conversation
  ;(def args {:zid 16906})
  ; load conv and do a recompute
  (def args {:zid 17175})
  (def conv
    (-> (load-conv args)
        (conv/conv-update [])))
  (keys conv)
  (matrix/get-column (nm/get-matrix (:raw-rating-mat conv)) 10)
  (matrix/get-column (nm/get-matrix (:rating-mat conv)) 10)
  (matrix/get-column (:mat conv) 10)
  (keys (:pca conv))
  (matrix/mget (:center (:pca conv)) 10)
  (matrix/get-column (:comps (:pca conv)) 10)
  (:mod-out conv)
  ; recompute on conv
  (def conv (conv/conv-update conv []))
  (do
    (conv/conv-update conv [])
    nil)
  ;; looks at results of conv
  (keys conv)
  (:raw-rating-mat conv)
  (:rating-mat conv)
  (:mat conv)
  (def conv
    (-> (load-conv args)
        (conv/conv-update [{:zid 11547 :pid 0 :tid 0 :vote 2.0 :created (System/currentTimeMillis)}])))

  (def updated-conv
    (-> conv
      (conv/mod-update [{:zid 15230 :tid 38 :is_meta true :modified (System/currentTimeMillis)}])
      (conv/conv-update [])))
  (:mod-out updated-conv)
  (:repness updated-conv)

  ;; Testing out updates via the pure conv-update function
  (let [updated-conv (conv/conv-update conv [{:zid 15228 :pid 0 :tid 0 :vote 2.0 :created (System/currentTimeMillis)}])
        _ (printn "colnames")
        updated-conv (conv/mod-update conv [{:zid 15230 :tid 38 :is_meta true :modified (System/currentTimeMillis)}])
        _ (log/info "First update")
        updated-conv' (conv/conv-update updated-conv [{:zid 15228 :pid 0 :tid 0 :vote -1 :created (System/currentTimeMillis)}])
        _ (log/info "Second update")]
    (log/info "Conv keys:" (keys conv))
    (log/info "Updated conv keys:" (keys updated-conv))
    (log/info "Previous conv key:" (boolean (:conv updated-conv)))
    (log/info "Previous conv key:" (boolean (:conv (:conv updated-conv'))))
    (:subgroup-clusters updated-conv'))
  ;(:repness updated-conv'))


  ;; Postgres/db testbench
  (postgres/query
    (:postgres runner/system)
    ["select * from votes
      limit 10;"])

  (postgres/query
    (:postgres runner/system)
    ["select * from votes
      where zid = ?;"
     4])

  (postgres/query
    (:postgres runner/system)
    ;; Builds a string like the above
    (honey/format
      {:select [:*]
       :from [:votes]
       :limit 10}))

  ;; This is the preferred way
  (postgres/query
    (:postgres runner/system)
    ;; Processes maps automatically, so you can do either of the two
    {:select [:*]
     :from [:votes]
     :limit 10})


  ;; Debugging issue
  (postgres/query
    (:postgres runner/system)
    {:select [:*]
     :from [:math_tasks]
     :limit 10})


  ;; Getting config settings
  (-> runner/system :config)
  (-> runner/system :config :webserver-url)

  (-> runner/system :config :darwin)
  (-> runner/system :config :darwin :webserver-url)
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
