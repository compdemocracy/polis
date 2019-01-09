;; gorilla-repl.fileformat = 1
;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.


;; **
;;; # Performance monitoring
;;; 
;;; We've begun puttng graph profile information into mongo. Time to start working on some monitoring tools.
;; **

;; @@
(ns performance-monitoring
  (:require [gorilla-plot.core :as plot]
            [gorilla-repl.table :as table]
            [polismath.utils :refer :all]
            [polismath.db :as db]
            [polismath.env :as env]
            [monger.core :as mg]
            [monger.collection :as mc]))
;; @@
;; =>
;;; {"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}
;; <=

;; **
;;; Below are the various plotting things we've done so far:
;; **

;; @@
(defn stat-plot
  [attr & opts]
  (apply plot/list-plot (map attr gp1-rep-stats) opts))

(defn stat-plots
  [attrs colors]
  (apply plot/compose (map #(stat-plot %1 :color %2 :width 500) attrs colors)))

(stat-plots [:pat :pdt] ["steelblue" "red"])
;; @@
;; =>
;;; {"type":"html","content":"<span class='clj-var'>#&#x27;performance-monitoring/stat-plots</span>","value":"#'performance-monitoring/stat-plots"}
;; <=

;; @@
(defn plot-attrs
  [users x-attr y-attr & {:keys [] :as kw-args}]
  (let [plot-args (merge {:opacity 0.3
                          :symbol-size 20}
                         kw-args)]
    (apply-kwargs
      plot/list-plot
      (map
        #(gets % [x-attr y-attr])
        users)
      plot-args)))


(plot-attrs icusers :remote-created-at :n-owned-convs-ptptd
            :plot-range [:all [0 20]])
;; @@

;; **
;;; Now let's start loading up some data to play around with.
;;; 
;; **

;; @@
(defn load-conv-profiles
  "Very bare bones reloading of the conversation; no cleanup for keyword/int hash-map key mismatches,
  as found in the :repness"
  [zid]
  (mc/find-one-as-map
    (db/mongo-db (env/env :mongolab-uri))
    (db/mongo-collection-name "profile")
    {:zid zid}))

;; @@
;; =>
;;; {"type":"html","content":"<span class='clj-var'>#&#x27;performance-monitoring/load-conv-profiles</span>","value":"#'performance-monitoring/load-conv-profiles"}
;; <=

;; @@
(load-conv-profiles 11586)
;; @@

;; @@
mc/
;; @@
