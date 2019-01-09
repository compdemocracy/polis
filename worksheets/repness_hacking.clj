;; gorilla-repl.fileformat = 1
;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.


;; **
;;; # Repness Hacking
;;; 
;;; Some time ago, I worked on some modifications to the repness code that attempt to get at least one "agree" statement before any disagrees for _every_ possible "disagree" comment. While this seemed to typically work (except in cases of moderation, where the 1st comment might be moderated out), there was a particular conversation where it did not, and where there was no moderation. This conversation has been saved to the file `badrepness.edn` (though may be moved in the future). (As a note to self, it had some issues with atoms and ndarrays not loading properly, and trying to analyze the structure was quite challenging, so we need a script for prettifying the edn).
;;; 
;;; We also have to figure out how to get global agree/disagree consensus in, as this is something that should really happen on the math end.
;;; 
;;; So let's get hacking.
;; **

;; @@
(ns repness-hacking
  (:require [gorilla-plot.core :as plot]
            [clojure.core.matrix :refer :all]
            [clojure.pprint :refer :all]
            [clojure.tools.reader.edn :as edn]
            [polismath [conversation :as conv]
                       [clusters :as clust]
                       [microscope :as ms]
                       [named-matrix :as nm]
                       [pretty-printers :as ppp]]))

; Getting the data
(def c (conv/read-vectorz-edn (slurp "badrepness.edn")))

; Helper
(defn head
  [data & [n]]
  (take (or n 7) data))

;; @@
;; =>
;;; {"type":"html","content":"<span class='clj-var'>#&#x27;repness-hacking/head</span>","value":"#'repness-hacking/head"}
;; <=

;; **
;;; To start, let's pull out the repness as `cr`.
;; **

;; @@
(def cr (:repness c))
(pprint (map (fn [[gid rs]] [gid (take 5 rs)]) cr))
;; @@
;; ->
;;; ([0
;;;   ({:tid 20,
;;;     :n-success 20,
;;;     :n-trials 23,
;;;     :p-success 21/25,
;;;     :p-test 3.674234614174767,
;;;     :repness 231/50,
;;;     :repness-test 4.610256,
;;;     :repful-for :agree}
;;;    {:tid 0,
;;;     :n-success 14,
;;;     :n-trials 22,
;;;     :p-success 5/8,
;;;     :p-test 1.4596008983995232,
;;;     :repness 15N,
;;;     :repness-test 4.3339744,
;;;     :repful-for :agree}
;;;    {:tid 23,
;;;     :n-success 18,
;;;     :n-trials 20,
;;;     :p-success 19/22,
;;;     :p-test 3.7097041340118704,
;;;     :repness 247/88,
;;;     :repness-test 3.4360168,
;;;     :repful-for :agree}
;;;    {:tid 8,
;;;     :n-success 21,
;;;     :n-trials 23,
;;;     :p-success 22/25,
;;;     :p-test 4.08248290463863,
;;;     :repness 46/25,
;;;     :repness-test 3.135133,
;;;     :repful-for :agree}
;;;    {:tid 24,
;;;     :n-success 9,
;;;     :n-trials 11,
;;;     :p-success 10/13,
;;;     :p-test 2.3094010767585025,
;;;     :repness 120/13,
;;;     :repness-test 3.5605416,
;;;     :repful-for :disagree})]
;;;  [1
;;;   ({:tid 22,
;;;     :n-success 0,
;;;     :n-trials 0,
;;;     :p-success 1/2,
;;;     :p-test 1.0,
;;;     :repness 13/10,
;;;     :repness-test 1.2146312,
;;;     :repful-for :disagree}
;;;    {:tid 7,
;;;     :n-success 4,
;;;     :n-trials 5,
;;;     :p-success 5/7,
;;;     :p-test 1.6329931618554516,
;;;     :repness 205/14,
;;;     :repness-test 4.981382,
;;;     :repful-for :disagree}
;;;    {:tid 15,
;;;     :n-success 4,
;;;     :n-trials 5,
;;;     :p-success 5/7,
;;;     :p-test 1.6329931618554516,
;;;     :repness 205/28,
;;;     :repness-test 4.2224436,
;;;     :repful-for :disagree}
;;;    {:tid 17,
;;;     :n-success 4,
;;;     :n-trials 5,
;;;     :p-success 5/7,
;;;     :p-test 1.6329931618554516,
;;;     :repness 43/7,
;;;     :repness-test 4.029963,
;;;     :repful-for :disagree}
;;;    {:tid 21,
;;;     :n-success 4,
;;;     :n-trials 5,
;;;     :p-success 5/7,
;;;     :p-test 1.6329931618554516,
;;;     :repness 39/7,
;;;     :repness-test 3.811882,
;;;     :repful-for :disagree})]
;;;  [2
;;;   ({:tid 1,
;;;     :n-success 15,
;;;     :n-trials 15,
;;;     :p-success 16/17,
;;;     :p-test 4.0,
;;;     :repness 96/17,
;;;     :repness-test 5.3267612,
;;;     :repful-for :agree}
;;;    {:tid 24,
;;;     :n-success 9,
;;;     :n-trials 10,
;;;     :p-success 5/6,
;;;     :p-test 2.7136021011998723,
;;;     :repness 65/18,
;;;     :repness-test 3.1851106,
;;;     :repful-for :agree}
;;;    {:tid 22,
;;;     :n-success 14,
;;;     :n-trials 16,
;;;     :p-success 5/6,
;;;     :p-test 3.1529631254723283,
;;;     :repness 115/42,
;;;     :repness-test 3.5232475,
;;;     :repful-for :agree}
;;;    {:tid 0,
;;;     :n-success 16,
;;;     :n-trials 17,
;;;     :p-success 17/19,
;;;     :p-test 3.771236166328253,
;;;     :repness 493/114,
;;;     :repness-test 4.833744,
;;;     :repful-for :disagree}
;;;    {:tid 20,
;;;     :n-success 11,
;;;     :n-trials 15,
;;;     :p-success 12/17,
;;;     :p-test 2.0,
;;;     :repness 72/17,
;;;     :repness-test 3.8254151,
;;;     :repful-for :disagree})])
;;; 
;; <-
;; =>
;;; {"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}
;; <=

;; **
;;; Ahah; I may not have noticed this before. The first one it's pulling for group 1 (comment tid=22) is a zero vote count comment. It's a little perplexing that it would have made it in through the filters set up for the "greedy agree", so let's take a closer look at the pre-compiled votes statistics.
;; **

;; @@
(def rep-stats (:stats (apply clust/conv-repness (map c [:rating-mat :group-clusters :base-clusters]))))
(ppp/wide-pp (take 3 rep-stats))
;; @@
;; ->
;;; ([{:pat 1.4596008983995232, :pd 5/24, :pa 5/8, :na 14, :pdt -2.7106873827419715, :nd 4, :ns 22, :rdt -3.833490860027325, :rat 4.333974311568233, :rd 5/18, :ra 15N}
;;;   {:pat -1.6329931618554516, :pd 2/7, :pa 1/7, :na 0, :pdt -0.816496580927726, :nd 1, :ns 5, :rdt -0.8755950357709134, :rat -0.9991315673568163, :rd 82/147, :ra 41/105}
;;;   {:pat -3.771236166328253, :pd 17/19, :pa 1/19, :na 0, :pdt 3.771236166328253, :nd 16, :ns 17, :rdt 4.83374382493315, :rat -3.3370168140018737, :rd 493/114, :ra 29/285}]
;;;  [{:pat -2.8577380332470415, :pd 3/5, :pa 1/5, :na 4, :pdt 1.224744871391589, :nd 14, :ns 23, :rdt 3.6567795003972843, :rat -3.7134700340621514, :rd 33/5, :ra 11/40}
;;;   {:pat -1.6329931618554516, :pd 2/7, :pa 1/7, :na 0, :pdt -0.816496580927726, :nd 1, :ns 5, :rdt -0.24119933043158806, :rat -1.5822244044174223, :rd 16/21, :ra 2/7}
;;;   {:pat 4.0, :pd 1/17, :pa 16/17, :na 15, :pdt -3.5, :nd 0, :ns 15, :rdt -3.240183808254108, :rat 5.326761139421704, :rd 15/136, :ra 96/17}]
;;;  [{:pat -2.449489742783178, :pd 3/5, :pa 6/25, :na 5, :pdt 1.224744871391589, :nd 14, :ns 23, :rdt -0.8390721778042801, :rat 1.4867727839306146, :rd 72/85, :ra 72/25}
;;;   {:pat -0.816496580927726, :pd 1/7, :pa 2/7, :na 1, :pdt -1.6329931618554516, :nd 0, :ns 5, :rdt -2.8928689424440197, :rat 1.138313561928329, :rd 6/31, :ra 2N}
;;;   {:pat -3.771236166328253, :pd 17/19, :pa 1/19, :na 0, :pdt 3.771236166328253, :nd 16, :ns 17, :rdt 3.0542031576959974, :rat -1.6478137206500227, :rd 34/19, :ra 30/133}])
;;; 
;; <-
;; =>
;;; {"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}
;; <=

;; **
;;; Since we're specifically interested in what's going on for grp 1, let's just pull that one out from the rest:
;; **

;; @@
(def gp1-rep-stats (mapv #(get % 1) rep-stats))
(ppp/wide-pp (take 3 gp1-rep-stats))
;; @@
;; ->
;;; ({:pat -1.6329931618554516, :pd 2/7, :pa 1/7, :na 0, :pdt -0.816496580927726, :nd 1, :ns 5, :rdt -0.8755950357709134, :rat -0.9991315673568163, :rd 82/147, :ra 41/105}
;;;  {:pat -1.6329931618554516, :pd 2/7, :pa 1/7, :na 0, :pdt -0.816496580927726, :nd 1, :ns 5, :rdt -0.24119933043158806, :rat -1.5822244044174223, :rd 16/21, :ra 2/7}
;;;  {:pat -0.816496580927726, :pd 1/7, :pa 2/7, :na 1, :pdt -1.6329931618554516, :nd 0, :ns 5, :rdt -2.8928689424440197, :rat 1.138313561928329, :rd 6/31, :ra 2N})
;;; 
;; <-
;; =>
;;; {"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}
;; <=

;; **
;;; And take a look at the raw stats for 22.
;; **

;; @@
(gp1-rep-stats 22)
;; @@
;; =>
;;; {"type":"list-like","open":"<span class='clj-record'>#polismath.clusters.graph-record20902{</span>","close":"<span class='clj-record'>}</span>","separator":" ","items":[{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:pat</span>","value":":pat"},{"type":"html","content":"<span class='clj-double'>1.0</span>","value":"1.0"}],"value":"[:pat 1.0]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:pd</span>","value":":pd"},{"type":"html","content":"<span class='clj-ratio'>1/2</span>","value":"1/2"}],"value":"[:pd 1/2]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:pa</span>","value":":pa"},{"type":"html","content":"<span class='clj-ratio'>1/2</span>","value":"1/2"}],"value":"[:pa 1/2]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:na</span>","value":":na"},{"type":"html","content":"<span class='clj-unkown'>0</span>","value":"0"}],"value":"[:na 0]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:pdt</span>","value":":pdt"},{"type":"html","content":"<span class='clj-double'>1.0</span>","value":"1.0"}],"value":"[:pdt 1.0]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:nd</span>","value":":nd"},{"type":"html","content":"<span class='clj-unkown'>0</span>","value":"0"}],"value":"[:nd 0]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:ns</span>","value":":ns"},{"type":"html","content":"<span class='clj-unkown'>0</span>","value":"0"}],"value":"[:ns 0]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:rdt</span>","value":":rdt"},{"type":"html","content":"<span class='clj-double'>1.2146311980878892</span>","value":"1.2146311980878892"}],"value":"[:rdt 1.2146311980878892]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:rat</span>","value":":rat"},{"type":"html","content":"<span class='clj-double'>0.8905403982733955</span>","value":"0.8905403982733955"}],"value":"[:rat 0.8905403982733955]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:rd</span>","value":":rd"},{"type":"html","content":"<span class='clj-ratio'>13/10</span>","value":"13/10"}],"value":"[:rd 13/10]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:ra</span>","value":":ra"},{"type":"html","content":"<span class='clj-ratio'>13/14</span>","value":"13/14"}],"value":"[:ra 13/14]"}],"value":"#polismath.clusters.graph-record20902{:pat 1.0, :pd 1/2, :pa 1/2, :na 0, :pdt 1.0, :nd 0, :ns 0, :rdt 1.2146311980878892, :rat 0.8905403982733955, :rd 13/10, :ra 13/14}"}
;; <=

;; **
;;; Let's do some plotting to explore the stats
;; **

;; @@
(defn stat-plot
  [attr & opts]
  (apply plot/list-plot (map attr gp1-rep-stats) opts))
;; @@
;; =>
;;; {"type":"html","content":"<span class='clj-var'>#&#x27;repness-hacking/stat-plot</span>","value":"#'repness-hacking/stat-plot"}
;; <=

;; @@
(defn stat-plots
  [attrs colors]
  (apply plot/compose (map #(stat-plot %1 :color %2 :width 500) attrs colors)))

(stat-plots [:pat :pdt] ["steelblue" "red"])
;; @@
;; =>
;;; {"type":"vega","content":{"width":400,"height":247.2187957763672,"padding":{"bottom":20,"top":10,"right":10,"left":50},"scales":[{"name":"x","type":"linear","range":"width","zero":false,"domain":{"data":"5b0991e0-49d8-419a-a679-5b2ede214560","field":"data.x"}},{"name":"y","type":"linear","range":"height","nice":true,"zero":false,"domain":{"data":"5b0991e0-49d8-419a-a679-5b2ede214560","field":"data.y"}}],"axes":[{"type":"x","scale":"x"},{"type":"y","scale":"y"}],"data":[{"name":"5b0991e0-49d8-419a-a679-5b2ede214560","values":[{"x":0,"y":-1.6329931618554516},{"x":1,"y":-1.6329931618554516},{"x":2,"y":-0.816496580927726},{"x":3,"y":0.0},{"x":4,"y":0.0},{"x":5,"y":-0.816496580927726},{"x":6,"y":0.0},{"x":7,"y":-0.816496580927726},{"x":8,"y":0.0},{"x":9,"y":0.0},{"x":10,"y":0.0},{"x":11,"y":0.0},{"x":12,"y":-0.816496580927726},{"x":13,"y":0.0},{"x":14,"y":-0.816496580927726},{"x":15,"y":-0.816496580927726},{"x":16,"y":0.0},{"x":17,"y":-0.816496580927726},{"x":18,"y":-0.816496580927726},{"x":19,"y":0.0},{"x":20,"y":0.0},{"x":21,"y":-0.816496580927726},{"x":22,"y":1.0},{"x":23,"y":1.0},{"x":24,"y":1.0},{"x":25,"y":1.0},{"x":26,"y":1.0},{"x":27,"y":1.0},{"x":28,"y":1.0},{"x":29,"y":1.0}]},{"name":"ea86c238-4924-4883-a65b-dc563f3f792d","values":[{"x":0,"y":-0.816496580927726},{"x":1,"y":-0.816496580927726},{"x":2,"y":-1.6329931618554516},{"x":3,"y":0.8164965809277264},{"x":4,"y":0.8164965809277264},{"x":5,"y":1.6329931618554516},{"x":6,"y":0.8164965809277264},{"x":7,"y":1.6329931618554516},{"x":8,"y":0.8164965809277264},{"x":9,"y":0.8164965809277264},{"x":10,"y":0.8164965809277264},{"x":11,"y":0.8164965809277264},{"x":12,"y":1.6329931618554516},{"x":13,"y":0.8164965809277264},{"x":14,"y":1.6329931618554516},{"x":15,"y":1.6329931618554516},{"x":16,"y":0.8164965809277264},{"x":17,"y":1.6329931618554516},{"x":18,"y":1.6329931618554516},{"x":19,"y":0.8164965809277264},{"x":20,"y":0.8164965809277264},{"x":21,"y":1.6329931618554516},{"x":22,"y":1.0},{"x":23,"y":1.0},{"x":24,"y":1.0},{"x":25,"y":1.0},{"x":26,"y":1.0},{"x":27,"y":1.0},{"x":28,"y":1.0},{"x":29,"y":1.0}]}],"marks":[{"type":"symbol","from":{"data":"5b0991e0-49d8-419a-a679-5b2ede214560"},"properties":{"enter":{"x":{"field":"data.x","scale":"x"},"y":{"field":"data.y","scale":"y"},"fill":{"value":"steelblue"},"fillOpacity":{"value":1}},"update":{"shape":"circle","size":{"value":70},"stroke":{"value":"transparent"}},"hover":{"size":{"value":210},"stroke":{"value":"white"}}}},{"type":"symbol","from":{"data":"ea86c238-4924-4883-a65b-dc563f3f792d"},"properties":{"enter":{"x":{"field":"data.x","scale":"x"},"y":{"field":"data.y","scale":"y"},"fill":{"value":"red"},"fillOpacity":{"value":1}},"update":{"shape":"circle","size":{"value":70},"stroke":{"value":"transparent"}},"hover":{"size":{"value":210},"stroke":{"value":"white"}}}}]},"value":"#gorilla_repl.vega.VegaView{:content {:width 400, :height 247.2188, :padding {:bottom 20, :top 10, :right 10, :left 50}, :scales [{:name \"x\", :type \"linear\", :range \"width\", :zero false, :domain {:data \"5b0991e0-49d8-419a-a679-5b2ede214560\", :field \"data.x\"}} {:name \"y\", :type \"linear\", :range \"height\", :nice true, :zero false, :domain {:data \"5b0991e0-49d8-419a-a679-5b2ede214560\", :field \"data.y\"}}], :axes [{:type \"x\", :scale \"x\"} {:type \"y\", :scale \"y\"}], :data ({:name \"5b0991e0-49d8-419a-a679-5b2ede214560\", :values ({:x 0, :y -1.6329931618554516} {:x 1, :y -1.6329931618554516} {:x 2, :y -0.816496580927726} {:x 3, :y 0.0} {:x 4, :y 0.0} {:x 5, :y -0.816496580927726} {:x 6, :y 0.0} {:x 7, :y -0.816496580927726} {:x 8, :y 0.0} {:x 9, :y 0.0} {:x 10, :y 0.0} {:x 11, :y 0.0} {:x 12, :y -0.816496580927726} {:x 13, :y 0.0} {:x 14, :y -0.816496580927726} {:x 15, :y -0.816496580927726} {:x 16, :y 0.0} {:x 17, :y -0.816496580927726} {:x 18, :y -0.816496580927726} {:x 19, :y 0.0} {:x 20, :y 0.0} {:x 21, :y -0.816496580927726} {:x 22, :y 1.0} {:x 23, :y 1.0} {:x 24, :y 1.0} {:x 25, :y 1.0} {:x 26, :y 1.0} {:x 27, :y 1.0} {:x 28, :y 1.0} {:x 29, :y 1.0})} {:name \"ea86c238-4924-4883-a65b-dc563f3f792d\", :values ({:x 0, :y -0.816496580927726} {:x 1, :y -0.816496580927726} {:x 2, :y -1.6329931618554516} {:x 3, :y 0.8164965809277264} {:x 4, :y 0.8164965809277264} {:x 5, :y 1.6329931618554516} {:x 6, :y 0.8164965809277264} {:x 7, :y 1.6329931618554516} {:x 8, :y 0.8164965809277264} {:x 9, :y 0.8164965809277264} {:x 10, :y 0.8164965809277264} {:x 11, :y 0.8164965809277264} {:x 12, :y 1.6329931618554516} {:x 13, :y 0.8164965809277264} {:x 14, :y 1.6329931618554516} {:x 15, :y 1.6329931618554516} {:x 16, :y 0.8164965809277264} {:x 17, :y 1.6329931618554516} {:x 18, :y 1.6329931618554516} {:x 19, :y 0.8164965809277264} {:x 20, :y 0.8164965809277264} {:x 21, :y 1.6329931618554516} {:x 22, :y 1.0} {:x 23, :y 1.0} {:x 24, :y 1.0} {:x 25, :y 1.0} {:x 26, :y 1.0} {:x 27, :y 1.0} {:x 28, :y 1.0} {:x 29, :y 1.0})}), :marks ({:type \"symbol\", :from {:data \"5b0991e0-49d8-419a-a679-5b2ede214560\"}, :properties {:enter {:x {:field \"data.x\", :scale \"x\"}, :y {:field \"data.y\", :scale \"y\"}, :fill {:value \"steelblue\"}, :fillOpacity {:value 1}}, :update {:shape \"circle\", :size {:value 70}, :stroke {:value \"transparent\"}}, :hover {:size {:value 210}, :stroke {:value \"white\"}}}} {:type \"symbol\", :from {:data \"ea86c238-4924-4883-a65b-dc563f3f792d\"}, :properties {:enter {:x {:field \"data.x\", :scale \"x\"}, :y {:field \"data.y\", :scale \"y\"}, :fill {:value \"red\"}, :fillOpacity {:value 1}}, :update {:shape \"circle\", :size {:value 70}, :stroke {:value \"transparent\"}}, :hover {:size {:value 210}, :stroke {:value \"white\"}}}})}}"}
;; <=

;; **
;;; Interesting. Maybe we don't actually have a problem here. It looks like they're actually _aren't_ any comments this group agrees with. It might have _appeared_ that way because of passes, which visually you wouldn't see as being any different than a "no-see-em". But above we can see that all of the agree probability tests are at 0 or below. But I'll have to look back to see how we're actually computing these. It's possible that by looking at `:pa` instead, we could get something better, but this leaves us exposed to problems of low confidence.
;;; 
;;; Also, something else worth looking at here is the discrete nature of these test scores. Let's start with a quick check of that:
;; **

;; @@
(set (map :pat gp1-rep-stats))
;; @@
;; =>
;;; {"type":"list-like","open":"<span class='clj-set'>#{</span>","close":"<span class='clj-set'>}</span>","separator":" ","items":[{"type":"html","content":"<span class='clj-double'>0.0</span>","value":"0.0"},{"type":"html","content":"<span class='clj-double'>1.0</span>","value":"1.0"},{"type":"html","content":"<span class='clj-double'>-1.6329931618554516</span>","value":"-1.6329931618554516"},{"type":"html","content":"<span class='clj-double'>-0.816496580927726</span>","value":"-0.816496580927726"}],"value":"#{0.0 1.0 -1.6329931618554516 -0.816496580927726}"}
;; <=

;; **
;;; Yup; that seems to check out. We must have low counts for this group; let's see:
;; **

;; @@
(:group-clusters c)
;; @@
;; =>
;;; {"type":"list-like","open":"<span class='clj-vector'>[</span>","close":"<span class='clj-vector'>]</span>","separator":" ","items":[{"type":"list-like","open":"<span class='clj-map'>{</span>","close":"<span class='clj-map'>}</span>","separator":", ","items":[{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:id</span>","value":":id"},{"type":"html","content":"<span class='clj-long'>0</span>","value":"0"}],"value":"[:id 0]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:members</span>","value":":members"},{"type":"list-like","open":"<span class='clj-vector'>[</span>","close":"<span class='clj-vector'>]</span>","separator":" ","items":[{"type":"html","content":"<span class='clj-long'>0</span>","value":"0"},{"type":"html","content":"<span class='clj-long'>7</span>","value":"7"},{"type":"html","content":"<span class='clj-long'>10</span>","value":"10"},{"type":"html","content":"<span class='clj-long'>13</span>","value":"13"},{"type":"html","content":"<span class='clj-long'>14</span>","value":"14"},{"type":"html","content":"<span class='clj-long'>15</span>","value":"15"},{"type":"html","content":"<span class='clj-long'>16</span>","value":"16"},{"type":"html","content":"<span class='clj-long'>17</span>","value":"17"},{"type":"html","content":"<span class='clj-long'>18</span>","value":"18"},{"type":"html","content":"<span class='clj-long'>20</span>","value":"20"},{"type":"html","content":"<span class='clj-long'>21</span>","value":"21"},{"type":"html","content":"<span class='clj-long'>22</span>","value":"22"},{"type":"html","content":"<span class='clj-long'>24</span>","value":"24"},{"type":"html","content":"<span class='clj-long'>25</span>","value":"25"},{"type":"html","content":"<span class='clj-long'>26</span>","value":"26"},{"type":"html","content":"<span class='clj-long'>31</span>","value":"31"},{"type":"html","content":"<span class='clj-long'>32</span>","value":"32"},{"type":"html","content":"<span class='clj-long'>33</span>","value":"33"},{"type":"html","content":"<span class='clj-long'>36</span>","value":"36"},{"type":"html","content":"<span class='clj-long'>39</span>","value":"39"},{"type":"html","content":"<span class='clj-long'>40</span>","value":"40"},{"type":"html","content":"<span class='clj-long'>41</span>","value":"41"},{"type":"html","content":"<span class='clj-long'>44</span>","value":"44"},{"type":"html","content":"<span class='clj-long'>45</span>","value":"45"}],"value":"[0 7 10 13 14 15 16 17 18 20 21 22 24 25 26 31 32 33 36 39 40 41 44 45]"}],"value":"[:members [0 7 10 13 14 15 16 17 18 20 21 22 24 25 26 31 32 33 36 39 40 41 44 45]]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:center</span>","value":":center"},{"type":"html","content":"<span class='clj-unkown'>#mikera.vectorz.Vector [-1.536237663142975 1.0653679098883733]</span>","value":"#mikera.vectorz.Vector [-1.536237663142975 1.0653679098883733]"}],"value":"[:center #mikera.vectorz.Vector [-1.536237663142975 1.0653679098883733]]"}],"value":"{:id 0, :members [0 7 10 13 14 15 16 17 18 20 21 22 24 25 26 31 32 33 36 39 40 41 44 45], :center #mikera.vectorz.Vector [-1.536237663142975 1.0653679098883733]}"},{"type":"list-like","open":"<span class='clj-map'>{</span>","close":"<span class='clj-map'>}</span>","separator":", ","items":[{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:id</span>","value":":id"},{"type":"html","content":"<span class='clj-long'>1</span>","value":"1"}],"value":"[:id 1]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:members</span>","value":":members"},{"type":"list-like","open":"<span class='clj-vector'>[</span>","close":"<span class='clj-vector'>]</span>","separator":" ","items":[{"type":"html","content":"<span class='clj-long'>1</span>","value":"1"},{"type":"html","content":"<span class='clj-long'>2</span>","value":"2"},{"type":"html","content":"<span class='clj-long'>3</span>","value":"3"},{"type":"html","content":"<span class='clj-long'>4</span>","value":"4"},{"type":"html","content":"<span class='clj-long'>6</span>","value":"6"}],"value":"[1 2 3 4 6]"}],"value":"[:members [1 2 3 4 6]]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:center</span>","value":":center"},{"type":"html","content":"<span class='clj-unkown'>#mikera.vectorz.Vector [3.912324626290324 0.792034445237892]</span>","value":"#mikera.vectorz.Vector [3.912324626290324 0.792034445237892]"}],"value":"[:center #mikera.vectorz.Vector [3.912324626290324 0.792034445237892]]"}],"value":"{:id 1, :members [1 2 3 4 6], :center #mikera.vectorz.Vector [3.912324626290324 0.792034445237892]}"},{"type":"list-like","open":"<span class='clj-map'>{</span>","close":"<span class='clj-map'>}</span>","separator":", ","items":[{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:id</span>","value":":id"},{"type":"html","content":"<span class='clj-long'>2</span>","value":"2"}],"value":"[:id 2]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:members</span>","value":":members"},{"type":"list-like","open":"<span class='clj-vector'>[</span>","close":"<span class='clj-vector'>]</span>","separator":" ","items":[{"type":"html","content":"<span class='clj-long'>5</span>","value":"5"},{"type":"html","content":"<span class='clj-long'>8</span>","value":"8"},{"type":"html","content":"<span class='clj-long'>9</span>","value":"9"},{"type":"html","content":"<span class='clj-long'>11</span>","value":"11"},{"type":"html","content":"<span class='clj-long'>12</span>","value":"12"},{"type":"html","content":"<span class='clj-long'>19</span>","value":"19"},{"type":"html","content":"<span class='clj-long'>23</span>","value":"23"},{"type":"html","content":"<span class='clj-long'>27</span>","value":"27"},{"type":"html","content":"<span class='clj-long'>28</span>","value":"28"},{"type":"html","content":"<span class='clj-long'>29</span>","value":"29"},{"type":"html","content":"<span class='clj-long'>30</span>","value":"30"},{"type":"html","content":"<span class='clj-long'>34</span>","value":"34"},{"type":"html","content":"<span class='clj-long'>35</span>","value":"35"},{"type":"html","content":"<span class='clj-long'>37</span>","value":"37"},{"type":"html","content":"<span class='clj-long'>38</span>","value":"38"},{"type":"html","content":"<span class='clj-long'>42</span>","value":"42"},{"type":"html","content":"<span class='clj-long'>43</span>","value":"43"}],"value":"[5 8 9 11 12 19 23 27 28 29 30 34 35 37 38 42 43]"}],"value":"[:members [5 8 9 11 12 19 23 27 28 29 30 34 35 37 38 42 43]]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:center</span>","value":":center"},{"type":"html","content":"<span class='clj-unkown'>#mikera.vectorz.Vector [-0.2700439057172588 -2.1974518306844097]</span>","value":"#mikera.vectorz.Vector [-0.2700439057172588 -2.1974518306844097]"}],"value":"[:center #mikera.vectorz.Vector [-0.2700439057172588 -2.1974518306844097]]"}],"value":"{:id 2, :members [5 8 9 11 12 19 23 27 28 29 30 34 35 37 38 42 43], :center #mikera.vectorz.Vector [-0.2700439057172588 -2.1974518306844097]}"}],"value":"[{:id 0, :members [0 7 10 13 14 15 16 17 18 20 21 22 24 25 26 31 32 33 36 39 40 41 44 45], :center #mikera.vectorz.Vector [-1.536237663142975 1.0653679098883733]} {:id 1, :members [1 2 3 4 6], :center #mikera.vectorz.Vector [3.912324626290324 0.792034445237892]} {:id 2, :members [5 8 9 11 12 19 23 27 28 29 30 34 35 37 38 42 43], :center #mikera.vectorz.Vector [-0.2700439057172588 -2.1974518306844097]}]"}
;; <=

;; **
;;; Sure enough; this group is only 5 ptpts. So there isn't much room for the stats to look to pretty. I'm guessing they didn't have much information about the votes as well.
;;; 
;;; In any case, let's move on to looking at how things sort by agree prob.
;; **

;; @@
(stat-plots [:rd :ra] ["red" "steelblue"])
;; @@
;; =>
;;; {"type":"vega","content":{"width":400,"height":247.2187957763672,"padding":{"bottom":20,"top":10,"right":10,"left":50},"scales":[{"name":"x","type":"linear","range":"width","zero":false,"domain":{"data":"b34a9f24-0b11-4d95-b2f4-c674f6b51bc8","field":"data.x"}},{"name":"y","type":"linear","range":"height","nice":true,"zero":false,"domain":{"data":"b34a9f24-0b11-4d95-b2f4-c674f6b51bc8","field":"data.y"}}],"axes":[{"type":"x","scale":"x"},{"type":"y","scale":"y"}],"data":[{"name":"b34a9f24-0b11-4d95-b2f4-c674f6b51bc8","values":[{"x":0,"y":0.5578231292517007},{"x":1,"y":0.7619047619047619},{"x":2,"y":0.1935483870967742},{"x":3,"y":7.80952380952381},{"x":4,"y":4.685714285714286},{"x":5,"y":2.928571428571429},{"x":6,"y":5.571428571428571},{"x":7,"y":14.64285714285714},{"x":8,"y":3.346938775510204},{"x":9,"y":11.71428571428571},{"x":10,"y":4},{"x":11,"y":5.714285714285714},{"x":12,"y":4.880952380952381},{"x":13,"y":2.928571428571429},{"x":14,"y":3.75},{"x":15,"y":7.321428571428571},{"x":16,"y":1.904761904761905},{"x":17,"y":6.142857142857143},{"x":18,"y":2.662337662337662},{"x":19,"y":1.904761904761905},{"x":20,"y":1.758241758241758},{"x":21,"y":5.571428571428571},{"x":22,"y":1.3},{"x":23,"y":1.65},{"x":24,"y":1.15},{"x":25,"y":1},{"x":26,"y":1.1875},{"x":27,"y":1.166666666666667},{"x":28,"y":2.333333333333333},{"x":29,"y":1.75}]},{"name":"1cfd30ec-e6e7-40d2-9e94-976737bfc4a1","values":[{"x":0,"y":0.3904761904761905},{"x":1,"y":0.2857142857142857},{"x":2,"y":2},{"x":3,"y":0.4749034749034749},{"x":4,"y":0.5324675324675325},{"x":5,"y":0.4685714285714286},{"x":6,"y":0.5223214285714286},{"x":7,"y":0.3003663003663004},{"x":8,"y":0.5857142857142857},{"x":9,"y":0.5020408163265306},{"x":10,"y":0.5454545454545455},{"x":11,"y":0.5357142857142857},{"x":12,"y":0.354978354978355},{"x":13,"y":0.5857142857142857},{"x":14,"y":0.4137931034482759},{"x":15,"y":0.3445378151260504},{"x":16,"y":0.6349206349206349},{"x":17,"y":0.3722943722943723},{"x":18,"y":0.5093167701863354},{"x":19,"y":0.9022556390977444},{"x":20,"y":0.7792207792207791},{"x":21,"y":0.3482142857142857},{"x":22,"y":0.9285714285714286},{"x":23,"y":0.75},{"x":24,"y":0.9583333333333333},{"x":25,"y":1.111111111111111},{"x":26,"y":1.055555555555556},{"x":27,"y":0.9545454545454545},{"x":28,"y":0.6363636363636364},{"x":29,"y":1.166666666666667}]}],"marks":[{"type":"symbol","from":{"data":"b34a9f24-0b11-4d95-b2f4-c674f6b51bc8"},"properties":{"enter":{"x":{"field":"data.x","scale":"x"},"y":{"field":"data.y","scale":"y"},"fill":{"value":"red"},"fillOpacity":{"value":1}},"update":{"shape":"circle","size":{"value":70},"stroke":{"value":"transparent"}},"hover":{"size":{"value":210},"stroke":{"value":"white"}}}},{"type":"symbol","from":{"data":"1cfd30ec-e6e7-40d2-9e94-976737bfc4a1"},"properties":{"enter":{"x":{"field":"data.x","scale":"x"},"y":{"field":"data.y","scale":"y"},"fill":{"value":"steelblue"},"fillOpacity":{"value":1}},"update":{"shape":"circle","size":{"value":70},"stroke":{"value":"transparent"}},"hover":{"size":{"value":210},"stroke":{"value":"white"}}}}]},"value":"#gorilla_repl.vega.VegaView{:content {:width 400, :height 247.2188, :padding {:bottom 20, :top 10, :right 10, :left 50}, :scales [{:name \"x\", :type \"linear\", :range \"width\", :zero false, :domain {:data \"b34a9f24-0b11-4d95-b2f4-c674f6b51bc8\", :field \"data.x\"}} {:name \"y\", :type \"linear\", :range \"height\", :nice true, :zero false, :domain {:data \"b34a9f24-0b11-4d95-b2f4-c674f6b51bc8\", :field \"data.y\"}}], :axes [{:type \"x\", :scale \"x\"} {:type \"y\", :scale \"y\"}], :data ({:name \"b34a9f24-0b11-4d95-b2f4-c674f6b51bc8\", :values ({:x 0, :y 82/147} {:x 1, :y 16/21} {:x 2, :y 6/31} {:x 3, :y 164/21} {:x 4, :y 164/35} {:x 5, :y 41/14} {:x 6, :y 39/7} {:x 7, :y 205/14} {:x 8, :y 164/49} {:x 9, :y 82/7} {:x 10, :y 4N} {:x 11, :y 40/7} {:x 12, :y 205/42} {:x 13, :y 41/14} {:x 14, :y 15/4} {:x 15, :y 205/28} {:x 16, :y 40/21} {:x 17, :y 43/7} {:x 18, :y 205/77} {:x 19, :y 40/21} {:x 20, :y 160/91} {:x 21, :y 39/7} {:x 22, :y 13/10} {:x 23, :y 33/20} {:x 24, :y 23/20} {:x 25, :y 1N} {:x 26, :y 19/16} {:x 27, :y 7/6} {:x 28, :y 7/3} {:x 29, :y 7/4})} {:name \"1cfd30ec-e6e7-40d2-9e94-976737bfc4a1\", :values ({:x 0, :y 41/105} {:x 1, :y 2/7} {:x 2, :y 2N} {:x 3, :y 123/259} {:x 4, :y 41/77} {:x 5, :y 82/175} {:x 6, :y 117/224} {:x 7, :y 82/273} {:x 8, :y 41/70} {:x 9, :y 123/245} {:x 10, :y 6/11} {:x 11, :y 15/28} {:x 12, :y 82/231} {:x 13, :y 41/70} {:x 14, :y 12/29} {:x 15, :y 41/119} {:x 16, :y 40/63} {:x 17, :y 86/231} {:x 18, :y 82/161} {:x 19, :y 120/133} {:x 20, :y 60/77} {:x 21, :y 39/112} {:x 22, :y 13/14} {:x 23, :y 3/4} {:x 24, :y 23/24} {:x 25, :y 10/9} {:x 26, :y 19/18} {:x 27, :y 21/22} {:x 28, :y 7/11} {:x 29, :y 7/6})}), :marks ({:type \"symbol\", :from {:data \"b34a9f24-0b11-4d95-b2f4-c674f6b51bc8\"}, :properties {:enter {:x {:field \"data.x\", :scale \"x\"}, :y {:field \"data.y\", :scale \"y\"}, :fill {:value \"red\"}, :fillOpacity {:value 1}}, :update {:shape \"circle\", :size {:value 70}, :stroke {:value \"transparent\"}}, :hover {:size {:value 210}, :stroke {:value \"white\"}}}} {:type \"symbol\", :from {:data \"1cfd30ec-e6e7-40d2-9e94-976737bfc4a1\"}, :properties {:enter {:x {:field \"data.x\", :scale \"x\"}, :y {:field \"data.y\", :scale \"y\"}, :fill {:value \"steelblue\"}, :fillOpacity {:value 1}}, :update {:shape \"circle\", :size {:value 70}, :stroke {:value \"transparent\"}}, :hover {:size {:value 210}, :stroke {:value \"white\"}}}})}}"}
;; <=

;; **
;;; Yeah... everything is below 0.5, which is not encouraging. There just isn't a way around it for this one.
;;; 
;;; What conversation is this again?
;; **

;; @@
(:zid c)
;; @@
;; =>
;;; {"type":"html","content":"<span class='clj-long'>12272</span>","value":"12272"}
;; <=

;; **
;;; And for this the zinvite is 9kzprjkfep (see [preprod](http://preprod.pol.is/9kzprjkfep) and [prod](http://pol.is/9kzprjkfep))
;; **

;; **
;;; Looking at that, we can see that there is still a problem, even if it isn't possible to get an agree comment. The issue is that, if it isn't possible to get such a comment, we shouldn't mess with the natural sorting _at all_. In the conversation in question, the first one shown (as we discovered earlier as well), has _no_ votes, which makes it seem very awkward.
;;; 
;;; Let's look into the code for this a bit more.
;; **

;; @@
(stat-plots [:ns :nd :na] ["lightgrey" "red" "steelblue"])
;; @@
;; =>
;;; {"type":"vega","content":{"width":400,"height":247.2187957763672,"padding":{"bottom":20,"top":10,"right":10,"left":50},"scales":[{"name":"x","type":"linear","range":"width","zero":false,"domain":{"data":"cf2f6156-4b20-4882-a1c2-333eca0af636","field":"data.x"}},{"name":"y","type":"linear","range":"height","nice":true,"zero":false,"domain":{"data":"cf2f6156-4b20-4882-a1c2-333eca0af636","field":"data.y"}}],"axes":[{"type":"x","scale":"x"},{"type":"y","scale":"y"}],"data":[{"name":"cf2f6156-4b20-4882-a1c2-333eca0af636","values":[{"x":0,"y":5},{"x":1,"y":5},{"x":2,"y":5},{"x":3,"y":5},{"x":4,"y":5},{"x":5,"y":5},{"x":6,"y":5},{"x":7,"y":5},{"x":8,"y":5},{"x":9,"y":5},{"x":10,"y":5},{"x":11,"y":5},{"x":12,"y":5},{"x":13,"y":5},{"x":14,"y":5},{"x":15,"y":5},{"x":16,"y":5},{"x":17,"y":5},{"x":18,"y":5},{"x":19,"y":5},{"x":20,"y":5},{"x":21,"y":5},{"x":22,"y":0},{"x":23,"y":0},{"x":24,"y":0},{"x":25,"y":0},{"x":26,"y":0},{"x":27,"y":0},{"x":28,"y":0},{"x":29,"y":0}]},{"name":"e787ccaf-7b16-463d-9927-8bab4dd414ea","values":[{"x":0,"y":1},{"x":1,"y":1},{"x":2,"y":0},{"x":3,"y":3},{"x":4,"y":3},{"x":5,"y":4},{"x":6,"y":3},{"x":7,"y":4},{"x":8,"y":3},{"x":9,"y":3},{"x":10,"y":3},{"x":11,"y":3},{"x":12,"y":4},{"x":13,"y":3},{"x":14,"y":4},{"x":15,"y":4},{"x":16,"y":3},{"x":17,"y":4},{"x":18,"y":4},{"x":19,"y":3},{"x":20,"y":3},{"x":21,"y":4},{"x":22,"y":0},{"x":23,"y":0},{"x":24,"y":0},{"x":25,"y":0},{"x":26,"y":0},{"x":27,"y":0},{"x":28,"y":0},{"x":29,"y":0}]},{"name":"99d96db7-e12b-4650-a48c-4a3ebc93bbe1","values":[{"x":0,"y":0},{"x":1,"y":0},{"x":2,"y":1},{"x":3,"y":2},{"x":4,"y":2},{"x":5,"y":1},{"x":6,"y":2},{"x":7,"y":1},{"x":8,"y":2},{"x":9,"y":2},{"x":10,"y":2},{"x":11,"y":2},{"x":12,"y":1},{"x":13,"y":2},{"x":14,"y":1},{"x":15,"y":1},{"x":16,"y":2},{"x":17,"y":1},{"x":18,"y":1},{"x":19,"y":2},{"x":20,"y":2},{"x":21,"y":1},{"x":22,"y":0},{"x":23,"y":0},{"x":24,"y":0},{"x":25,"y":0},{"x":26,"y":0},{"x":27,"y":0},{"x":28,"y":0},{"x":29,"y":0}]}],"marks":[{"type":"symbol","from":{"data":"cf2f6156-4b20-4882-a1c2-333eca0af636"},"properties":{"enter":{"x":{"field":"data.x","scale":"x"},"y":{"field":"data.y","scale":"y"},"fill":{"value":"lightgrey"},"fillOpacity":{"value":1}},"update":{"shape":"circle","size":{"value":70},"stroke":{"value":"transparent"}},"hover":{"size":{"value":210},"stroke":{"value":"white"}}}},{"type":"symbol","from":{"data":"e787ccaf-7b16-463d-9927-8bab4dd414ea"},"properties":{"enter":{"x":{"field":"data.x","scale":"x"},"y":{"field":"data.y","scale":"y"},"fill":{"value":"red"},"fillOpacity":{"value":1}},"update":{"shape":"circle","size":{"value":70},"stroke":{"value":"transparent"}},"hover":{"size":{"value":210},"stroke":{"value":"white"}}}},{"type":"symbol","from":{"data":"99d96db7-e12b-4650-a48c-4a3ebc93bbe1"},"properties":{"enter":{"x":{"field":"data.x","scale":"x"},"y":{"field":"data.y","scale":"y"},"fill":{"value":"steelblue"},"fillOpacity":{"value":1}},"update":{"shape":"circle","size":{"value":70},"stroke":{"value":"transparent"}},"hover":{"size":{"value":210},"stroke":{"value":"white"}}}}]},"value":"#gorilla_repl.vega.VegaView{:content {:width 400, :height 247.2188, :padding {:bottom 20, :top 10, :right 10, :left 50}, :scales [{:name \"x\", :type \"linear\", :range \"width\", :zero false, :domain {:data \"cf2f6156-4b20-4882-a1c2-333eca0af636\", :field \"data.x\"}} {:name \"y\", :type \"linear\", :range \"height\", :nice true, :zero false, :domain {:data \"cf2f6156-4b20-4882-a1c2-333eca0af636\", :field \"data.y\"}}], :axes [{:type \"x\", :scale \"x\"} {:type \"y\", :scale \"y\"}], :data ({:name \"cf2f6156-4b20-4882-a1c2-333eca0af636\", :values ({:x 0, :y 5} {:x 1, :y 5} {:x 2, :y 5} {:x 3, :y 5} {:x 4, :y 5} {:x 5, :y 5} {:x 6, :y 5} {:x 7, :y 5} {:x 8, :y 5} {:x 9, :y 5} {:x 10, :y 5} {:x 11, :y 5} {:x 12, :y 5} {:x 13, :y 5} {:x 14, :y 5} {:x 15, :y 5} {:x 16, :y 5} {:x 17, :y 5} {:x 18, :y 5} {:x 19, :y 5} {:x 20, :y 5} {:x 21, :y 5} {:x 22, :y 0} {:x 23, :y 0} {:x 24, :y 0} {:x 25, :y 0} {:x 26, :y 0} {:x 27, :y 0} {:x 28, :y 0} {:x 29, :y 0})} {:name \"e787ccaf-7b16-463d-9927-8bab4dd414ea\", :values ({:x 0, :y 1} {:x 1, :y 1} {:x 2, :y 0} {:x 3, :y 3} {:x 4, :y 3} {:x 5, :y 4} {:x 6, :y 3} {:x 7, :y 4} {:x 8, :y 3} {:x 9, :y 3} {:x 10, :y 3} {:x 11, :y 3} {:x 12, :y 4} {:x 13, :y 3} {:x 14, :y 4} {:x 15, :y 4} {:x 16, :y 3} {:x 17, :y 4} {:x 18, :y 4} {:x 19, :y 3} {:x 20, :y 3} {:x 21, :y 4} {:x 22, :y 0} {:x 23, :y 0} {:x 24, :y 0} {:x 25, :y 0} {:x 26, :y 0} {:x 27, :y 0} {:x 28, :y 0} {:x 29, :y 0})} {:name \"99d96db7-e12b-4650-a48c-4a3ebc93bbe1\", :values ({:x 0, :y 0} {:x 1, :y 0} {:x 2, :y 1} {:x 3, :y 2} {:x 4, :y 2} {:x 5, :y 1} {:x 6, :y 2} {:x 7, :y 1} {:x 8, :y 2} {:x 9, :y 2} {:x 10, :y 2} {:x 11, :y 2} {:x 12, :y 1} {:x 13, :y 2} {:x 14, :y 1} {:x 15, :y 1} {:x 16, :y 2} {:x 17, :y 1} {:x 18, :y 1} {:x 19, :y 2} {:x 20, :y 2} {:x 21, :y 1} {:x 22, :y 0} {:x 23, :y 0} {:x 24, :y 0} {:x 25, :y 0} {:x 26, :y 0} {:x 27, :y 0} {:x 28, :y 0} {:x 29, :y 0})}), :marks ({:type \"symbol\", :from {:data \"cf2f6156-4b20-4882-a1c2-333eca0af636\"}, :properties {:enter {:x {:field \"data.x\", :scale \"x\"}, :y {:field \"data.y\", :scale \"y\"}, :fill {:value \"lightgrey\"}, :fillOpacity {:value 1}}, :update {:shape \"circle\", :size {:value 70}, :stroke {:value \"transparent\"}}, :hover {:size {:value 210}, :stroke {:value \"white\"}}}} {:type \"symbol\", :from {:data \"e787ccaf-7b16-463d-9927-8bab4dd414ea\"}, :properties {:enter {:x {:field \"data.x\", :scale \"x\"}, :y {:field \"data.y\", :scale \"y\"}, :fill {:value \"red\"}, :fillOpacity {:value 1}}, :update {:shape \"circle\", :size {:value 70}, :stroke {:value \"transparent\"}}, :hover {:size {:value 210}, :stroke {:value \"white\"}}}} {:type \"symbol\", :from {:data \"99d96db7-e12b-4650-a48c-4a3ebc93bbe1\"}, :properties {:enter {:x {:field \"data.x\", :scale \"x\"}, :y {:field \"data.y\", :scale \"y\"}, :fill {:value \"steelblue\"}, :fillOpacity {:value 1}}, :update {:shape \"circle\", :size {:value 70}, :stroke {:value \"transparent\"}}, :hover {:size {:value 210}, :stroke {:value \"white\"}}}})}}"}
;; <=

;; **
;;; I've just updated the `beats-best-agrr?` so that it doesn't accept any comments which havne't actually been voted on. It's really just a very manual thing:
;;; 
;; **

;; @@
(comment
    (defn- beats-best-agrr?
      "Like beats-best-by-test?, but only considers agrees. Additionally, doesn't focus solely on repness,
      but also on raw probability of agreement, so as to ensure that there is some representation of what
      people in the group agree on. Also, note that this takes the current-best, instead of just current-best-z."
      [{:keys [ra rat pa pat ns] :as comment-conv-stats} current-best]
      (cond
       ; Explicitly don't let something that hasn't been voted on at all come into repness
        (= ns 0)
            false
        ; If we have a current-best by repness estimate, use the more robust measurement
        (and current-best (> (:ra current-best) 1.0))
            ; XXX - a litte messy, since we're basicaly reimplimenting the repness sort function
            (> (* ra rat pa pat) (apply * (map current-best [:ra :rat :pa :pat])))
        ; If we have current-best, but only by prob estimate, just shoot for something that is generally agreed upon
        current-best
            (> (* pa pat) (apply * (map current-best [:pa :pat])))
        ; Otherwise, accept if either repness or probability look generally good
        :else
            (or (> ra 1.0)
                (> pa 0.5)))))

;; @@
;; =>
;;; {"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}
;; <=

;; **
;;; Before we reload this and try it out, let's save what we already have, so that we can load it in later:
;; **

;; @@

(let [filename "old/oldbadrepness-reps.edn"]
  (when-not (.exists (clojure.java.io/as-file filename))
    (->> rep-stats
         (map
           #(map (partial into {}) %))
         (pr-str)
         (spit filename)))
  (->> filename
       slurp
       (take 80)
       (apply str)
       ))
;; @@
;; =>
;;; {"type":"html","content":"<span class='clj-string'>&quot;(({:rat 4.333974311568233, :ra 15N, :ns 22, :nd 4, :na 14, :rd 5/18, :pdt -2.710&quot;</span>","value":"\"(({:rat 4.333974311568233, :ra 15N, :ns 22, :nd 4, :na 14, :rd 5/18, :pdt -2.710\""}
;; <=

;; **
;;; Now let's try out the reload:
;; **

;; @@
(require '[polismath.clusters :as clust :reload true]
         '[polismath.conversation :as conv :reload true])
(-> c
    (conv/conv-update [])
    (:repness)
    (get 1)
    (pprint))

;; @@
;; ->
;;; ({:tid 3,
;;;   :n-success 3,
;;;   :n-trials 5,
;;;   :p-success 4/7,
;;;   :p-test 0.8164965809277264,
;;;   :repness 164/21,
;;;   :repness-test 3.762533,
;;;   :repful-for :disagree}
;;;  {:tid 7,
;;;   :n-success 4,
;;;   :n-trials 5,
;;;   :p-success 5/7,
;;;   :p-test 1.6329931618554516,
;;;   :repness 205/14,
;;;   :repness-test 4.981382,
;;;   :repful-for :disagree}
;;;  {:tid 15,
;;;   :n-success 4,
;;;   :n-trials 5,
;;;   :p-success 5/7,
;;;   :p-test 1.6329931618554516,
;;;   :repness 205/28,
;;;   :repness-test 4.2224436,
;;;   :repful-for :disagree}
;;;  {:tid 17,
;;;   :n-success 4,
;;;   :n-trials 5,
;;;   :p-success 5/7,
;;;   :p-test 1.6329931618554516,
;;;   :repness 43/7,
;;;   :repness-test 4.029963,
;;;   :repful-for :disagree}
;;;  {:tid 21,
;;;   :n-success 4,
;;;   :n-trials 5,
;;;   :p-success 5/7,
;;;   :p-test 1.6329931618554516,
;;;   :repness 39/7,
;;;   :repness-test 3.811882,
;;;   :repful-for :disagree})
;;; 
;; <-
;; =>
;;; {"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}
;; <=

;; **
;;; Hmm... well, that partly worked. But since we're still at all `:disagree` comments, it should be the case that the "best" such comment by repness should be first, but it's not. So let's take a look and see what's going on here with the actual raw stats.
;; **

;; @@
(def new-raw
  (->>
    (apply clust/conv-repness (map c [:rating-mat :group-clusters :base-clusters]))
    :stats
    (mapv #(get % 1))
    ))

(pprint (nth new-raw 3))

;; @@
;; ->
;;; {:pat 0.0,
;;;  :pd 4/7,
;;;  :pa 3/7,
;;;  :na 2,
;;;  :pdt 0.8164965809277264,
;;;  :nd 3,
;;;  :ns 5,
;;;  :rdt 3.762532984128439,
;;;  :rat -2.8824902428282386,
;;;  :rd 164/21,
;;;  :ra 123/259}
;;; 
;; <-
;; =>
;;; {"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}
;; <=

;; **
;;; Hm... ok. Let's just tinker around with this in here manually:
;; **

;; @@
(defn beats-best-agrr?
  "Like beats-best-by-test?, but only considers agrees. Additionally, doesn't focus solely on repness,
  but also on raw probability of agreement, so as to ensure that there is some representation of what
  people in the group agree on. Also, note that this takes the current-best, instead of just current-best-z."
  [{:keys [ra rat pa pat ns] :as comment-conv-stats} current-best]
  (cond
   ; Explicitly don't let something that hasn't been voted on at all come into repness
    (= ns 0)
        false
    ; If we have a current-best by repness estimate, use the more robust measurement
    (and current-best (> (:ra current-best) 1.0))
        ; XXX - a litte messy, since we're basicaly reimplimenting the repness sort function
        (> (* ra rat pa pat) (apply * (map current-best [:ra :rat :pa :pat])))
    ; If we have current-best, but only by prob estimate, just shoot for something that is generally agreed upon
    current-best
        (> (* pa pat) (apply * (map current-best [:pa :pat])))
    ; Otherwise, accept if either repness or probability look generally good
    :else
        (or (> ra 1.0)
            (> pa 0.5))))


(beats-best-agrr? (nth new-raw 3) nil)
;; @@
;; =>
;;; {"type":"html","content":"<span class='clj-unkown'>false</span>","value":"false"}
;; <=

;; **
;;; OK; So that's actually coming out exactly as it should be. So perhaps there is something wrong with the standard thing that puts the "best" first. 
;;; 
;;; I just did some code rewriting/cleanup. Let's see what pops out of this now.
;; **

;; @@
(require '[polismath.clusters :as clust :reload true]
         '[polismath.conversation :as conv :reload true])


(->
  (apply clust/conv-repness (map c [:rating-mat :group-clusters :base-clusters]))
  (clust/select-rep-comments)
  (get 1)
  pprint)

;; @@
;; ->
;;; {:tid 20, :n-success 20, :n-trials 23, :p-success 21/25, :p-test 3.674234614174767, :repness 231/50, :repness-test 4.610256, :repful-for :agree}
;;; {:tid 3, :n-success 3, :n-trials 5, :p-success 4/7, :p-test 0.8164965809277264, :repness 164/21, :repness-test 3.762533, :repful-for :disagree}
;;; {:tid 1, :n-success 15, :n-trials 15, :p-success 16/17, :p-test 4.0, :repness 96/17, :repness-test 5.3267612, :repful-for :agree}
;;; ({:tid 3,
;;;   :n-success 3,
;;;   :n-trials 5,
;;;   :p-success 4/7,
;;;   :p-test 0.8164965809277264,
;;;   :repness 164/21,
;;;   :repness-test 3.762533,
;;;   :repful-for :disagree}
;;;  {:tid 7,
;;;   :n-success 4,
;;;   :n-trials 5,
;;;   :p-success 5/7,
;;;   :p-test 1.6329931618554516,
;;;   :repness 205/14,
;;;   :repness-test 4.981382,
;;;   :repful-for :disagree}
;;;  {:tid 15,
;;;   :n-success 4,
;;;   :n-trials 5,
;;;   :p-success 5/7,
;;;   :p-test 1.6329931618554516,
;;;   :repness 205/28,
;;;   :repness-test 4.2224436,
;;;   :repful-for :disagree}
;;;  {:tid 17,
;;;   :n-success 4,
;;;   :n-trials 5,
;;;   :p-success 5/7,
;;;   :p-test 1.6329931618554516,
;;;   :repness 43/7,
;;;   :repness-test 4.029963,
;;;   :repful-for :disagree}
;;;  {:tid 21,
;;;   :n-success 4,
;;;   :n-trials 5,
;;;   :p-success 5/7,
;;;   :p-test 1.6329931618554516,
;;;   :repness 39/7,
;;;   :repness-test 3.811882,
;;;   :repful-for :disagree})
;;; 
;; <-
;; =>
;;; {"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}
;; <=

;; **
;;; Hmm... I've been having trouble getting this to actually work; Maybe 3 _is_ supposed to be in there because everyone else agrees. But then why was 7 the next one on the old data? Let's check the `repness-metric` values.
;;; 
;; **

;; @@
(stat-plot (fn [{:keys [rd rdt pd pdt]}] (* rd rdt pd pdt)))
;; @@
;; =>
;;; {"type":"vega","content":{"axes":[{"type":"x","scale":"x"},{"type":"y","scale":"y"}],"scales":[{"name":"x","type":"linear","range":"width","zero":false,"domain":{"data":"0d0cd9a5-ab29-40a9-a088-b0398af898f5","field":"data.x"}},{"name":"y","type":"linear","range":"height","nice":true,"zero":false,"domain":{"data":"0d0cd9a5-ab29-40a9-a088-b0398af898f5","field":"data.y"}}],"marks":[{"type":"symbol","from":{"data":"0d0cd9a5-ab29-40a9-a088-b0398af898f5"},"properties":{"enter":{"x":{"field":"data.x","scale":"x"},"y":{"field":"data.y","scale":"y"},"fill":{"value":"steelblue"},"fillOpacity":{"value":1}},"update":{"shape":"circle","size":{"value":70},"stroke":{"value":"transparent"}},"hover":{"size":{"value":210},"stroke":{"value":"white"}}}}],"data":[{"name":"0d0cd9a5-ab29-40a9-a088-b0398af898f5","values":[{"x":0,"y":0.11394260241925702},{"x":1,"y":0.04287095044777109},{"x":2,"y":0.13061848482456492},{"x":3,"y":13.709486585460168},{"x":4,"y":6.818465635313264},{"x":5,"y":9.709279555017597},{"x":6,"y":8.613021460275261},{"x":7,"y":85.08088065800538},{"x":8,"y":4.1113933334112405},{"x":9,"y":22.859226122533734},{"x":10,"y":5.428336932643211},{"x":11,"y":8.970252685131706},{"x":12,"y":20.832801671769513},{"x":13,"y":3.3169076420783856},{"x":14,"y":14.27767497909334},{"x":15,"y":36.05919326367589},{"x":16,"y":1.5197622138099365},{"x":17,"y":28.87538617420961},{"x":18,"y":8.315281210554804},{"x":19,"y":1.5197622138099365},{"x":20,"y":1.2861285134331333},{"x":21,"y":24.772072155833154},{"x":22,"y":0.789510278757128},{"x":23,"y":1.1848160458484682},{"x":24,"y":0.6140655065064246},{"x":25,"y":0.46401616866730944},{"x":26,"y":0.6430176824700359},{"x":27,"y":0.62691373675597},{"x":28,"y":1.9142961929988558},{"x":29,"y":1.0913167378090662}]}],"width":400,"height":247.2187957763672,"padding":{"bottom":20,"top":10,"right":10,"left":50}},"value":"#gorilla_repl.vega.VegaView{:content {:axes [{:type \"x\", :scale \"x\"} {:type \"y\", :scale \"y\"}], :scales [{:name \"x\", :type \"linear\", :range \"width\", :zero false, :domain {:data \"0d0cd9a5-ab29-40a9-a088-b0398af898f5\", :field \"data.x\"}} {:name \"y\", :type \"linear\", :range \"height\", :nice true, :zero false, :domain {:data \"0d0cd9a5-ab29-40a9-a088-b0398af898f5\", :field \"data.y\"}}], :marks [{:type \"symbol\", :from {:data \"0d0cd9a5-ab29-40a9-a088-b0398af898f5\"}, :properties {:enter {:x {:field \"data.x\", :scale \"x\"}, :y {:field \"data.y\", :scale \"y\"}, :fill {:value \"steelblue\"}, :fillOpacity {:value 1}}, :update {:shape \"circle\", :size {:value 70}, :stroke {:value \"transparent\"}}, :hover {:size {:value 210}, :stroke {:value \"white\"}}}}], :data [{:name \"0d0cd9a5-ab29-40a9-a088-b0398af898f5\", :values ({:x 0, :y 0.11394260241925702} {:x 1, :y 0.04287095044777109} {:x 2, :y 0.13061848482456492} {:x 3, :y 13.709486585460168} {:x 4, :y 6.818465635313264} {:x 5, :y 9.709279555017597} {:x 6, :y 8.613021460275261} {:x 7, :y 85.08088065800538} {:x 8, :y 4.1113933334112405} {:x 9, :y 22.859226122533734} {:x 10, :y 5.428336932643211} {:x 11, :y 8.970252685131706} {:x 12, :y 20.832801671769513} {:x 13, :y 3.3169076420783856} {:x 14, :y 14.27767497909334} {:x 15, :y 36.05919326367589} {:x 16, :y 1.5197622138099365} {:x 17, :y 28.87538617420961} {:x 18, :y 8.315281210554804} {:x 19, :y 1.5197622138099365} {:x 20, :y 1.2861285134331333} {:x 21, :y 24.772072155833154} {:x 22, :y 0.789510278757128} {:x 23, :y 1.1848160458484682} {:x 24, :y 0.6140655065064246} {:x 25, :y 0.46401616866730944} {:x 26, :y 0.6430176824700359} {:x 27, :y 0.62691373675597} {:x 28, :y 1.9142961929988558} {:x 29, :y 1.0913167378090662})}], :width 400, :height 247.2188, :padding {:bottom 20, :top 10, :right 10, :left 50}}}"}
;; <=

;; **
;;; Yeah... there is no stinking reasong that 3 should be first there. Unless... it's actually coming up as positive?
;; **

;; @@
(require '[polismath.clusters :as clust :reload true])

(def new-stats
  (->>
    (apply clust/conv-repness (map c [:rating-mat :group-clusters :base-clusters]))
    :stats
    (mapv #(get % 1))))
    ;(get 3)
    ;pprint))
    ;(clust/beats-best-agr? nil))

;; @@
;; =>
;;; {"type":"html","content":"<span class='clj-var'>#&#x27;repness-hacking/new-stats</span>","value":"#'repness-hacking/new-stats"}
;; <=

;; @@
(require '[polismath.clusters :as clust :reload true])

(->> (map #(assoc %1 :tid %2) new-stats (range))
     (take 4)
     (reduce
       (fn [res s]
         (if (clust/beats-best-agr? s res)
           s
           res))
       nil))
;; @@
;; ->
;;; ph 3
;;; ph 3
;;; ph 3
;;; ph 1
;;; 
;; <-
;; =>
;;; {"type":"list-like","open":"<span class='clj-record'>#polismath.clusters.graph-record103808{</span>","close":"<span class='clj-record'>}</span>","separator":" ","items":[{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:pat</span>","value":":pat"},{"type":"html","content":"<span class='clj-double'>0.0</span>","value":"0.0"}],"value":"[:pat 0.0]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:pd</span>","value":":pd"},{"type":"html","content":"<span class='clj-ratio'>4/7</span>","value":"4/7"}],"value":"[:pd 4/7]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:pa</span>","value":":pa"},{"type":"html","content":"<span class='clj-ratio'>3/7</span>","value":"3/7"}],"value":"[:pa 3/7]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:na</span>","value":":na"},{"type":"html","content":"<span class='clj-unkown'>2</span>","value":"2"}],"value":"[:na 2]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:pdt</span>","value":":pdt"},{"type":"html","content":"<span class='clj-double'>0.8164965809277264</span>","value":"0.8164965809277264"}],"value":"[:pdt 0.8164965809277264]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:nd</span>","value":":nd"},{"type":"html","content":"<span class='clj-unkown'>3</span>","value":"3"}],"value":"[:nd 3]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:ns</span>","value":":ns"},{"type":"html","content":"<span class='clj-unkown'>5</span>","value":"5"}],"value":"[:ns 5]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:tid</span>","value":":tid"},{"type":"html","content":"<span class='clj-long'>3</span>","value":"3"}],"value":"[:tid 3]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:rdt</span>","value":":rdt"},{"type":"html","content":"<span class='clj-double'>3.762532984128439</span>","value":"3.762532984128439"}],"value":"[:rdt 3.762532984128439]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:rat</span>","value":":rat"},{"type":"html","content":"<span class='clj-double'>-2.8824902428282386</span>","value":"-2.8824902428282386"}],"value":"[:rat -2.8824902428282386]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:rd</span>","value":":rd"},{"type":"html","content":"<span class='clj-ratio'>164/21</span>","value":"164/21"}],"value":"[:rd 164/21]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:ra</span>","value":":ra"},{"type":"html","content":"<span class='clj-ratio'>123/259</span>","value":"123/259"}],"value":"[:ra 123/259]"}],"value":"#polismath.clusters.graph-record103808{:pat 0.0, :pd 4/7, :pa 3/7, :na 2, :pdt 0.8164965809277264, :nd 3, :ns 5, :tid 3, :rdt 3.762532984128439, :rat -2.8824902428282386, :rd 164/21, :ra 123/259}"}
;; <=

;; @@
(pprint (take 4 new-stats))
;; @@
;; ->
;;; ({:pat -1.6329931618554516,
;;;   :pd 2/7,
;;;   :pa 1/7,
;;;   :na 0,
;;;   :pdt -0.816496580927726,
;;;   :nd 1,
;;;   :ns 5,
;;;   :rdt -0.8755950357709134,
;;;   :rat -0.9991315673568163,
;;;   :rd 82/147,
;;;   :ra 41/105}
;;;  {:pat -1.6329931618554516,
;;;   :pd 2/7,
;;;   :pa 1/7,
;;;   :na 0,
;;;   :pdt -0.816496580927726,
;;;   :nd 1,
;;;   :ns 5,
;;;   :rdt -0.24119933043158806,
;;;   :rat -1.5822244044174223,
;;;   :rd 16/21,
;;;   :ra 2/7}
;;;  {:pat -0.816496580927726,
;;;   :pd 1/7,
;;;   :pa 2/7,
;;;   :na 1,
;;;   :pdt -1.6329931618554516,
;;;   :nd 0,
;;;   :ns 5,
;;;   :rdt -2.8928689424440197,
;;;   :rat 1.138313561928329,
;;;   :rd 6/31,
;;;   :ra 2N}
;;;  {:pat 0.0,
;;;   :pd 4/7,
;;;   :pa 3/7,
;;;   :na 2,
;;;   :pdt 0.8164965809277264,
;;;   :nd 3,
;;;   :ns 5,
;;;   :rdt 3.762532984128439,
;;;   :rat -2.8824902428282386,
;;;   :rd 164/21,
;;;   :ra 123/259})
;;; 
;; <-
;; =>
;;; {"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}
;; <=

;; **
;;; OK; I see what's happening. I need to make the third option here a little more strict. I've modified it; let's see what happens now.
;; **

;; @@
(require '[polismath.clusters :as clust :reload true]
         '[polismath.conversation :as conv :reload true])


(->
  (apply clust/conv-repness (map c [:rating-mat :group-clusters :base-clusters]))
  (clust/select-rep-comments)
  (get 1)
  pprint)
;; @@
;; ->
;;; {:tid 20, :n-success 20, :n-trials 23, :p-success 21/25, :p-test 3.674234614174767, :repness 231/50, :repness-test 4.610256, :repful-for :agree}
;;; nil
;;; {:tid 1, :n-success 15, :n-trials 15, :p-success 16/17, :p-test 4.0, :repness 96/17, :repness-test 5.3267612, :repful-for :agree}
;;; ({:tid 7,
;;;   :n-success 4,
;;;   :n-trials 5,
;;;   :p-success 5/7,
;;;   :p-test 1.6329931618554516,
;;;   :repness 205/14,
;;;   :repness-test 4.981382,
;;;   :repful-for :disagree}
;;;  {:tid 15,
;;;   :n-success 4,
;;;   :n-trials 5,
;;;   :p-success 5/7,
;;;   :p-test 1.6329931618554516,
;;;   :repness 205/28,
;;;   :repness-test 4.2224436,
;;;   :repful-for :disagree}
;;;  {:tid 17,
;;;   :n-success 4,
;;;   :n-trials 5,
;;;   :p-success 5/7,
;;;   :p-test 1.6329931618554516,
;;;   :repness 43/7,
;;;   :repness-test 4.029963,
;;;   :repful-for :disagree}
;;;  {:tid 21,
;;;   :n-success 4,
;;;   :n-trials 5,
;;;   :p-success 5/7,
;;;   :p-test 1.6329931618554516,
;;;   :repness 39/7,
;;;   :repness-test 3.811882,
;;;   :repful-for :disagree}
;;;  {:tid 12,
;;;   :n-success 4,
;;;   :n-trials 5,
;;;   :p-success 5/7,
;;;   :p-test 1.6329931618554516,
;;;   :repness 205/42,
;;;   :repness-test 3.6592052,
;;;   :repful-for :disagree})
;;; 
;; <-
;; =>
;;; {"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}
;; <=

;; **
;;; Woohoo! Sweet! Looks good. Let's do a sanity check on the rest of them.
;; **

;; @@

(->
  (apply clust/conv-repness (map c [:rating-mat :group-clusters :base-clusters]))
  (clust/select-rep-comments)
  pprint)
;; @@
;; ->
;;; {:tid 20, :n-success 20, :n-trials 23, :p-success 21/25, :p-test 3.674234614174767, :repness 231/50, :repness-test 4.610256, :repful-for :agree}
;;; nil
;;; {:tid 1, :n-success 15, :n-trials 15, :p-success 16/17, :p-test 4.0, :repness 96/17, :repness-test 5.3267612, :repful-for :agree}
;;; {0
;;;  ({:tid 20,
;;;    :n-success 20,
;;;    :n-trials 23,
;;;    :p-success 21/25,
;;;    :p-test 3.674234614174767,
;;;    :repness 231/50,
;;;    :repness-test 4.610256,
;;;    :repful-for :agree}
;;;   {:tid 0,
;;;    :n-success 14,
;;;    :n-trials 22,
;;;    :p-success 5/8,
;;;    :p-test 1.4596008983995232,
;;;    :repness 15N,
;;;    :repness-test 4.3339744,
;;;    :repful-for :agree}
;;;   {:tid 23,
;;;    :n-success 18,
;;;    :n-trials 20,
;;;    :p-success 19/22,
;;;    :p-test 3.7097041340118704,
;;;    :repness 247/88,
;;;    :repness-test 3.4360168,
;;;    :repful-for :agree}
;;;   {:tid 8,
;;;    :n-success 21,
;;;    :n-trials 23,
;;;    :p-success 22/25,
;;;    :p-test 4.08248290463863,
;;;    :repness 46/25,
;;;    :repness-test 3.135133,
;;;    :repful-for :agree}
;;;   {:tid 24,
;;;    :n-success 9,
;;;    :n-trials 11,
;;;    :p-success 10/13,
;;;    :p-test 2.3094010767585025,
;;;    :repness 120/13,
;;;    :repness-test 3.5605416,
;;;    :repful-for :disagree}),
;;;  1
;;;  ({:tid 7,
;;;    :n-success 4,
;;;    :n-trials 5,
;;;    :p-success 5/7,
;;;    :p-test 1.6329931618554516,
;;;    :repness 205/14,
;;;    :repness-test 4.981382,
;;;    :repful-for :disagree}
;;;   {:tid 15,
;;;    :n-success 4,
;;;    :n-trials 5,
;;;    :p-success 5/7,
;;;    :p-test 1.6329931618554516,
;;;    :repness 205/28,
;;;    :repness-test 4.2224436,
;;;    :repful-for :disagree}
;;;   {:tid 17,
;;;    :n-success 4,
;;;    :n-trials 5,
;;;    :p-success 5/7,
;;;    :p-test 1.6329931618554516,
;;;    :repness 43/7,
;;;    :repness-test 4.029963,
;;;    :repful-for :disagree}
;;;   {:tid 21,
;;;    :n-success 4,
;;;    :n-trials 5,
;;;    :p-success 5/7,
;;;    :p-test 1.6329931618554516,
;;;    :repness 39/7,
;;;    :repness-test 3.811882,
;;;    :repful-for :disagree}
;;;   {:tid 12,
;;;    :n-success 4,
;;;    :n-trials 5,
;;;    :p-success 5/7,
;;;    :p-test 1.6329931618554516,
;;;    :repness 205/42,
;;;    :repness-test 3.6592052,
;;;    :repful-for :disagree}),
;;;  2
;;;  ({:tid 1,
;;;    :n-success 15,
;;;    :n-trials 15,
;;;    :p-success 16/17,
;;;    :p-test 4.0,
;;;    :repness 96/17,
;;;    :repness-test 5.3267612,
;;;    :repful-for :agree}
;;;   {:tid 24,
;;;    :n-success 9,
;;;    :n-trials 10,
;;;    :p-success 5/6,
;;;    :p-test 2.7136021011998723,
;;;    :repness 65/18,
;;;    :repness-test 3.1851106,
;;;    :repful-for :agree}
;;;   {:tid 22,
;;;    :n-success 14,
;;;    :n-trials 16,
;;;    :p-success 5/6,
;;;    :p-test 3.1529631254723283,
;;;    :repness 115/42,
;;;    :repness-test 3.5232475,
;;;    :repful-for :agree}
;;;   {:tid 0,
;;;    :n-success 16,
;;;    :n-trials 17,
;;;    :p-success 17/19,
;;;    :p-test 3.771236166328253,
;;;    :repness 493/114,
;;;    :repness-test 4.833744,
;;;    :repful-for :disagree}
;;;   {:tid 20,
;;;    :n-success 11,
;;;    :n-trials 15,
;;;    :p-success 12/17,
;;;    :p-test 2.0,
;;;    :repness 72/17,
;;;    :repness-test 3.8254151,
;;;    :repful-for :disagree})}
;;; 
;; <-
;; =>
;;; {"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}
;; <=

;; @@

;; @@
