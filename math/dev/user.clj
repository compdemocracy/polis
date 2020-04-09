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
            [plumbing.core :as plmb]
            [honeysql.core :as honey]
            [clojure.core.matrix :as matrix]
            [clojure.core.async :as async :refer [>! <! >!! <!! go go-loop thread]]
            [clojure.set :as set]
            [clojure.string :as string]
            [clojure.pprint :as pp]
            [environ.core :as env]
            [taoensso.timbre :as log]
            [taoensso.timbre.profiling :as prof]
            [oz.core :as oz]
            [cheshire.core :as chesh]
            [tentacles.gists :as gists]))


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
   :layer [
           {:mark "rule"
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
   :layer [
           {:mark "rule"
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

;(p! conv)

;(oz/v! {:data {:values [{:x 1 :y 2} {:x 3 :y 4.3}]}
        ;:layer [{:mark "point"
                 ;:encoding {:x {:field "x"} :y {:field "y"}}}]})

;; Test calls here
;(def plot-data
;  (conv-data conv))
;(def the-plot
  ;(p! conv))


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
                  ;:y {:field "priority"}}})))



(defn prob-dist
  "Messy function for investigating statistical distributions. Given a sample of comments selected
  from the server's get comments fn, or from a page reload, this function returns the subset of those
  comments which fall in the uppermost percentile of comments. By tracing back y values on a cdf plot to
  the x values at which they intersect the cft, you can get a sense of what portion of sample should fall
  within the specified percentile and then compare that to what you get here."
  [conv sample percentile & {:keys [in-conv]}]
  (let [comment-priorities
        (->> (:comment-priorities conv)
             (sort-by second)
             (remove (comp (set/difference (:mod-out conv) (:meta-tids conv))
                           first))
             (filter (comp
                       (set (or in-conv (:tids conv)))
                       first)))]
    (log/info (count (vec comment-priorities)))
    (set/intersection
      (into #{}
        (map first
          (take-last (log/spy :info (int (* (count comment-priorities) percentile)))
                     comment-priorities)))
      (set sample))))



;; Can toggle between do and comment here for refiring entire file
;(do
(comment
  (oz/start-plot-server!)
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
  ;(let [matrix (nm/get-matrix (:raw-rating-mat conv))]
    ;(->> matrix
         ;matrix/columns
         ;(map
           ;(fn [col]
             ;(let [seen (remove nil? col)
                   ;agree ()]
               ;#(/ % (-> matrix matrix/shape first))
               ;count
               ;double)))
         ;sort))

  ;; Look at profile output
  (sort-by (comp - second) @(:profile-data conv))
  (reduce + (map second @(:profile-data conv)))

  ;; Plot the conversation
  (p! conv)

  ;; Run correlation matrix
  ;(corr/default-tids conv)

  ;; Let's try another conversation

  (def zid2 17023)
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
                                 zid2
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
