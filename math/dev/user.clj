(ns user
  (:require
   [cider.nrepl]
   [clojure.core.matrix :as matrix]
   [clojure.pprint :as pp]
   [clojure.set :as set]
   [honeysql.core :as honey]
   [nrepl.server :as nrepl-server]
   [oz.core :as oz]
   [polismath.components.postgres :as postgres]
   [polismath.conv-man :as conv-man]
   [polismath.math.conversation :as conv]
   [polismath.math.named-matrix :as nm]
   [polismath.runner :as runner]
   [polismath.system :as system]
   [taoensso.timbre :as log]))

;; Conv loading utilities

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
           [(str "g-" gid "-votes") (str (get-in data [:votes tid]))])
         (:group-votes conv))))


(defn importance-metric
  [A P S E]
  (let [p (/ (+ P 1) (+ S 2))
        a (/ (+ A 1) (+ S 2))]
    (* (- 1 p) (+ E 1) a)))


(defn cmnt-stats
  [conv tid extremity]
  (let [group-votes (:group-votes conv)
        {:as total-votes :keys [A D S P]}
        ;; reduce over votes per group, already aggregated
        (reduce
         (fn [votes [gid data]]
           (let [{:as data :keys [A S D]} (get-in data [:votes tid])
                 data (assoc data :P (+ (- S (+ A D))))]
             ;; Add in each of the data's kv count pairs
             (reduce
              (fn [votes' [k v]]
                (update votes' k + v))
              votes
              data)))
         {:A 0 :D 0 :S 0 :P 0}
         group-votes)
        importance
        (importance-metric A P S extremity)
        priority
        (get-in conv [:comment-priorities tid])]
    (log/spy
     {:total-votes (str total-votes)
      :priority priority
      :importance importance
      :fontSize (* priority 40)})))


(defn comments-data
  [conv]
  (->>
   (map
    (fn [tid extremity [x y]]
      (merge
       {:tid tid
        :label tid
        :x x
        :y y
        :extremity extremity
        :type "comment"}
       (cmnt-group-votes conv tid)
       (cmnt-stats conv tid extremity)))
    (:tids conv)
    (-> conv :pca :comment-extremity)
    (-> conv :pca :comment-projection matrix/transpose))
   (remove (comp (:mod-out conv) :tid))))


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
   (subgroup-clusters-data conv)
   (base-clusters-data conv)))


(def size-scale
  {:bandSize 100
   :pointSizeRange [1 100]})

(def conv-plot
  {:width 2000
   :height 1300
   :layer [{:mark "rule"
            :encoding {:x {:value 0 :scale {:zero false}}}}
           ;{:mark "rule"
           ; :encoding {:x {:value 0.0}}}
           {:mark {:type "point" :filled true}
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
                       :size {:field "fontSize"}
                       :text {:field "label"}}}]})

(def conv-plot
  {:width 2000
   :height 1300
   :layer [{:mark "rule"
            :encoding {:x {:value 0 :scale {:zero false}}}}
           ;{:mark "rule"
           ; :encoding {:x {:value 0.0}}}
           {:mark {:type "point" :filled true}
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
                       :size {:field "fontSize"}
                       :text {:field "label"}}}]})



(defn p!
  ([conv]
   (oz/v! conv-plot :data {:values (conv-data conv)})))


(defn integrate
  [coll]
  (:result
   (reduce
    (fn [result x]
      (-> result
          (update :total + x)
          (update :result conj (+ (:total result) x))))
    {:total 0 :result []}
    coll)))

(defn plot-priorities!
  [conv & {:keys [strict-mod exclude-meta]}]
  (let [values
        (->> (:comment-priorities conv)
             (remove (comp
                      (set/union
                       (if exclude-meta (:meta-tids conv) #{})
                       (if strict-mod
                         (set/difference (set (:tids conv)) (:mod-in conv))
                         (set/difference (:mod-out conv) (:meta-tids conv))))
                      first))
             (sort-by second))
        max-integral
        (apply max (integrate (vals values)))
        comments
        (into {} (map (fn [c] [(:tid c) c])
                      (comments-data conv)))
        entities
        (map
         (fn [i [tid x] X]
           (merge
            (get comments tid)
            {:rank i
             :rank-perc (/ i (count values))
             :tid tid
             :priority x
             :integral X
             :prob (/ X max-integral)
             :is-meta (boolean (get (:meta-tids conv) tid))
             :mod-out (boolean (get (:mod-out conv) tid))}))
         (range)
         values
         (integrate (vals values)))]
    (oz/v!
     {:data {:values entities}
      :title "Priority CDF"
      :width 1400
      :height 900
      :mark "bar"
      :encoding {:x {:field "rank-perc"}
                 :y {:field "prob"}}})))


(defn run-with-repl
  [_]
  (runner/run! system/full-system)
  (log/info "System running; starting nREPL on port 18975")
  (nrepl-server/start-server :bind "0.0.0.0" :port 18975 :handler cider.nrepl/cider-nrepl-handler))



;; Can toggle between do and comment here for refiring entire file
;(do
(comment
  (oz/start-plot-server!)
  ;; Run one of these to interactively test out a particular system or subsystem
  (runner/run! system/base-system)
  ;(runner/run! system/poller-system {:poll-from-days-ago 0.1})
  ;(runner/run! system/task-system {:poll-from-days-ago 3})
  ;(runner/run! system/full-system {:poll-from-days-ago 0.1})
  ;(runner/run! system/darwin-system)


  ;; Execute this to run pure math/util tests
  (require '[runner :as test-runner])
  ;; Rerun the tests once runner has been required by executing this
  (test-runner/-main)


  ;; Setting up load and interactive testing for a specific conversation
  ; load conv and do a recompute
  ;(def zid 17794)
  ;(def zid 17175)
  ;(def zid 16703)
  ;(def zid 16906)
  (def zid 17890) ; med-small
  ;(def zid 18115) ; big cmnts; med ptpts
  (def args {:zid zid})

  (def conv
    (-> (load-conv args)
        (conv/conv-update [])))

  (def priority-plot (plot-priorities! conv :strict-mod true :exclude-meta true))
  (pp/pprint priority-plot)
  (oz/publish-plot! priority-plot)


  (->> (nm/get-matrix (:raw-rating-mat conv))
       matrix/shape)
  (sort (keys conv))

  ;; Look at profile output
  (sort-by (comp - second) @(:profile-data conv))
  (reduce + (map second @(:profile-data conv)))

  ;; Plot the conversation
  (p! conv)

  ;; Let's try another conversation

  (def zid2 17023)
  (def args2 {:zid zid2})
  (def conv2 (load-conv args2))

  ;; queue votes through conv-man
  (conv-man/queue-message-batch! (:conversation-manager runner/system)
                                 :votes
                                 zid2
                                 [])


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

  :end)
