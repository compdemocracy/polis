;; gorilla-repl.fileformat = 1

;; **
;;; # Gorilla REPL
;;; 
;;; Welcome to gorilla :-)
;;; 
;;; Shift + enter evaluates code. Hit alt+g twice in quick succession or click the menu icon (upper-right corner) for more commands ...
;;; 
;;; First, the namespace...
;; **

;; @@
(ns sunset-canyon
  (:require [gorilla-plot.core :as plot]
            ;; Polis things
            [polismath.math.conversation :as conv]
            [polismath.runner :as runner]
            [polismath.system :as system]
            [polismath.conv-man :as conv-man]
            [clojure.core.matrix :as matrix]
            [gg4clj.core :as gg]
            [user]))
;; @@
;; =>
;;; {"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}
;; <=

;; **
;;; Start the system
;;; 
;;; 
;; **

;; @@
;; 90% of the time, this is fine
(do
  (runner/run! system/base-system {:math-env :dev})

  ;; If you ever want to run the vote or task pollers, see below
  ;(runner/run! system/poller-system {:math-env :dev :poll-from-days-ago 0.1})
  ;(runner/run! system/task-system {:math-env :preprod :poll-from-days-ago 3})
  
  ;; elide system from gorilla file (system shows env credentials; need to fix this)...
  nil)

;; @@
;; ->
;;; 17-12-07 00:20:43 paleta INFO [polismath.components.config:147] - &gt;&gt; Starting config component
;;; 17-12-07 00:20:43 paleta INFO [polismath.components.core-matrix-boot:39] - &gt;&gt; Starting CoreMatrixBooter with implementation: :vectorz
;;; 17-12-07 00:20:44 paleta INFO [polismath.components.postgres:55] - &gt;&gt; Starting Postgres component
;;; 17-12-07 00:20:44 paleta INFO [polismath.conv-man:411] - &gt;&gt; Starting ConversationManager
;;; 
;; <-
;; =>
;;; {"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}
;; <=

;; **
;;; Now we can load up a conversation by zid
;;; 
;;; 
;; **

;; @@
;; This is for the big whipping conversation
;(def zid 17794)
;; This is a smaller low problematic conv
(def zid1 16906)

;; Load the conv, and run an update on it
(def args1 {:zid zid1})
(def conv1
  (-> (user/load-conv args1)
      (conv/conv-update [])))
;; @@
;; ->
;;; 17-12-07 00:20:58 paleta INFO [polismath.conv-man:186] - Running load or init
;;; 17-12-07 00:20:58 paleta INFO [polismath.components.postgres:442] - load-conv called for zid 16906
;;; 17-12-07 00:21:00 paleta INFO [polismath.components.postgres:231] - conv-poll for zid 16906 , last-vote-timestap 0
;;; 17-12-07 00:21:01 paleta INFO [polismath.components.postgres:246] - conv-mod-poll for zid 16906 , last-vote-timestap 0
;;; 17-12-07 00:21:01 paleta INFO [polismath.math.conversation:705] - Starting conv-update for zid 16906: N=18, C=18, V=0
;;; 17-12-07 00:21:02 paleta DEBUG [polismath.math.conversation:520] - Found smoothed-k: 2
;;; 17-12-07 00:21:02 paleta DEBUG [polismath.math.conversation:520] - Found smoothed-k: 2
;;; 17-12-07 00:21:02 paleta DEBUG [polismath.math.conversation:520] - Found smoothed-k: 2
;;; 
;; <-
;; =>
;;; {"type":"html","content":"<span class='clj-var'>#&#x27;sunset-canyon/conv1</span>","value":"#'sunset-canyon/conv1"}
;; <=

;; **
;;; Check out conversation
;; **

;; @@
(keys conv1)
(keys (:pca conv1))

(def pca-center-plot (plot/list-plot (-> conv1 :pca :center vec)))
pca-center-plot

"The components:"
(-> conv1 :pca :comps matrix/transpose (plot/list-plot))

"The comment proj:"
(-> conv1 :pca :comment-projection matrix/transpose (plot/list-plot))



;; @@
;; =>
;;; {"type":"html","content":"<span class='clj-unkown'>(:profile-data :user-vote-counts :bid-to-pid :rating-mat :group-clusterings :pca :zid :group-clusters :n :consensus :customs :n-cmts :last-vote-timestamp :bucket-dists :base-clusters-weights :repness :opts&#x27; :group-aware-consensus :subgroup-clusters :subgroup-repness :votes-base :subgroup-clusterings-silhouettes :base-clusters :group-clusterings-silhouettes :mod-out :group-votes :subgroup-k-smoother :proj-nmat :subgroup-ptpt-stats :subgroup-votes :mat :subgroup-clusterings :ptpt-stats :proj :raw-rating-mat :group-k-smoother :in-conv :base-clusters-proj :tids)</span>","value":"(:profile-data :user-vote-counts :bid-to-pid :rating-mat :group-clusterings :pca :zid :group-clusters :n :consensus :customs :n-cmts :last-vote-timestamp :bucket-dists :base-clusters-weights :repness :opts' :group-aware-consensus :subgroup-clusters :subgroup-repness :votes-base :subgroup-clusterings-silhouettes :base-clusters :group-clusterings-silhouettes :mod-out :group-votes :subgroup-k-smoother :proj-nmat :subgroup-ptpt-stats :subgroup-votes :mat :subgroup-clusterings :ptpt-stats :proj :raw-rating-mat :group-k-smoother :in-conv :base-clusters-proj :tids)"}
;; <=

;; @@
;; More plotting...

"The ptpt proj:"
(-> conv1 keys)
(conv-data (into {:x :y :id}))
(gg/view [[:<- :g (gg4clj/data-frame g-dat)]
          (gg4clj/r+
            [:ggplot :g [:aes :g1 :g2]]
            [:xlim -2 2]
            [:ylim -2 2]
            [:geom_point {:colour "steelblue" :size 4}]
            [:stat_density2d {:colour "#FF29D2"}]
            [:theme_bw])]
         {:width 5 :height 5})
;; @@
;; =>
;;; {"type":"html","content":"<span class='clj-unkown'>(:profile-data :user-vote-counts :bid-to-pid :rating-mat :group-clusterings :pca :zid :group-clusters :n :consensus :customs :n-cmts :last-vote-timestamp :bucket-dists :base-clusters-weights :repness :opts&#x27; :group-aware-consensus :subgroup-clusters :subgroup-repness :votes-base :subgroup-clusterings-silhouettes :base-clusters :group-clusterings-silhouettes :mod-out :group-votes :subgroup-k-smoother :proj-nmat :subgroup-ptpt-stats :subgroup-votes :mat :subgroup-clusterings :ptpt-stats :proj :raw-rating-mat :group-k-smoother :in-conv :base-clusters-proj :tids)</span>","value":"(:profile-data :user-vote-counts :bid-to-pid :rating-mat :group-clusterings :pca :zid :group-clusters :n :consensus :customs :n-cmts :last-vote-timestamp :bucket-dists :base-clusters-weights :repness :opts' :group-aware-consensus :subgroup-clusters :subgroup-repness :votes-base :subgroup-clusterings-silhouettes :base-clusters :group-clusterings-silhouettes :mod-out :group-votes :subgroup-k-smoother :proj-nmat :subgroup-ptpt-stats :subgroup-votes :mat :subgroup-clusterings :ptpt-stats :proj :raw-rating-mat :group-k-smoother :in-conv :base-clusters-proj :tids)"}
;; <=

;; **
;;; Eventually, stop the system
;;; 
;; **

;; @@
(runner/stop!)
;; @@
