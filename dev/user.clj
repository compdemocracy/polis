(ns user
  (:require [polismath.runner :as runner]
            [polismath.system :as system]
            [polismath.meta.microscope :as microscope]
            [polismath.conv-man :as conv-man]
            [polismath.math.conversation :as conv]
            [polismath.components.postgres :as postgres]
            [polismath.math.named-matrix :as nm]
            [polismath.math.corr :as corr]
            [polismath.tasks :as tasks]
            [honeysql.core :as honey]
            [clojure.core.matrix :as matrix]
            [clojure.core.async :as async :refer [>! <! >!! <!! go go-loop thread]]
            [environ.core :as env]
            [taoensso.timbre :as log]
            [taoensso.timbre.profiling :as prof]
            [vizard.core :as viz]
            [clojure.data.json :as json]))


;; Conv loading utilities

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


;; Plotting utilities

(defn cmnt-group-votes
  [conv tid]
  (into {}
    (map
      (fn [[gid data]]
        [(str "g-"gid "-votes") (str (get-in data [:votes tid]))])
      (:group-votes conv))))


(defn comments-data
  [conv]
  (map
    (fn [tid [x y]]
      (merge
        {:label tid
         :x x
         :y y
         :type "comment"}
        (cmnt-group-votes conv tid)))
    (:tids conv)
    (-> conv :pca :comment-projection matrix/transpose)))


(defn groups-data
  [conv]
  (map
    (fn [{:keys [id center members]}]
      (let [[x y] (vec center)
            pids (->> (:base-clusters conv)
                    (filter (comp (set members) :id))
                    (mapcat :members))]
        {:size (count pids)
         :x x
         :y y
         :bids members
         :pids pids
         :type "group"
         :label (str "g-" id)}))
    (:group-clusters conv)))

(defn base-clusters-data
  [conv]
  (map
    (fn [{:keys [id center members]}]
      (let [[x y] (vec center)]
        {:size (count members)
         :x x
         :y y
         :pids members
         :type "base-cluster"
         :label ""}))
    (:base-clusters conv)))


(defn subgroup-clusters-data
  [conv]
  (mapcat
    (fn [[gid subgroups]]
      (map
        (fn [{:keys [id center members parent-id]}]
          (let [[x y] (vec center)
                pids (->> (:base-clusters conv)
                          (filter (comp (set members) :id))
                          (mapcat :members))]
            {:size (count pids)
             :x x
             :y y
             :bids members
             :pids pids
             :gid gid
             :type "subgroup-cluster"
             :parent parent-id
             :label (str "g-" gid "-sg-" id)}))
        subgroups))
    (:subgroup-clusters conv)))

(defn conv-data
  [conv]
  (concat
    (comments-data conv)
    (groups-data conv)
    (subgroup-clusters-data conv)))
    ;(base-clusters-data conv)))


(def size-scale
  {:bandSize 100
   :pointSizeRange [1 100]})

(def conv-plot
  {:width 2000
   :height 1300
   :layer [{:mark {:type "point" :filled true}
            :encoding {:x {:field "x"}
                       :y {:field "y"}
                       :size {:field "size" :scale size-scale}
                       :color {:field "type"}}}
           {:mark "point"
            :encoding {:x {:field "x"}
                       :y {:field "y"}
                       :size {:field "size"
                              :scale size-scale}
                       :opacity {:value 0.5}
                       :color {:value "#000"}}}
           {:mark "text"
            :encoding {:x {:field "x"}
                       :y {:field "y"}
                       :text {:field "label"}}}]})

(defn p! [conv]
  (viz/p! (assoc conv-plot :data {:values (conv-data conv)})))

;; Test calls here
;(def plot-data
;  (conv-data conv))
;(def the-plot
;  (p! conv))




;; Can toggle between do and comment here for refiring entire file
;(do
(comment
  (viz/start-plot-server!)
  ;; Run one of these to interactively test out a particular system or subsystem
  (runner/run! system/base-system {:math-env :preprod})
  ;(runner/run! system/poller-system {:math-env :dev :poll-from-days-ago 0.1})
  ;(runner/run! system/task-system {:math-env :preprod :poll-from-days-ago 3})
  ;(runner/run! system/full-system {:math-env :preprod :poll-from-days-ago 0.1})
  ;(runner/run! system/darwin-system)


  ;; Execute this to run pure math/util tests
  (require '[runner :as test-runner])
  ;; Rerun the tests once runner has been required by executing this
  (test-runner/-main)


  ;; Setting up load and interactive testing for a specific conversation
  ; load conv and do a recompute
  (def zid 17794)
  ;(def zid 17175)
  ;(def zid 16703)
  ;(def zid 16906)
  (def args {:zid zid})

  (def special-opts
    {:n-comps 2 ; does our code even generalize to others?
     :pca-iters 1
     :base-iters 1
     :base-k 100
     :max-k 5
     :group-iters 1
     ;; These three in particular we should be able to tune quickly
     :max-ptpts 80000
     :max-cmts 800
     :group-k-buffer 4})

  (def conv
    (-> (load-conv args)
        (conv/conv-update [] special-opts)))

  ;; Look at profile output
  (sort-by (comp - second) @(:profile-data conv))
  (reduce + (map second @(:profile-data conv)))

  ;; Plot the conversation
  (p! conv)

  ;; Run correlation matrix
  ;(corr/default-tids conv)

  ;; Let's try another conversation

  (def zid2 17175)
  (def args2 {:zid zid2})
  (def conv2 (load-conv args2))
  ;; Profiling
  (prof/profile
    :info
    :stuffnpuff
    (def conv2 (conv/conv-update conv2 [])))

  ;; queue votes through conv-man
  (conv-man/queue-message-batch! (:conversation-manager runner/system)
                                 :votes
                                 zid
                                 [])

  ;; test queuing report task
  ;(conv-man/queue-message-batch! (:conversation-manager runner/system)
  ;                               :generate_report_data
  ;                               zid2
  ;                               ;; these are probably wrong...
  ;                               [{:rid 6 :zid 15228 :math_tick 52}])


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
