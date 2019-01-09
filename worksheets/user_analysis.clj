;; gorilla-repl.fileformat = 1
;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.


;; **
;;; # User Analysis
;;; 
;;; Intercom is great, but falls short on analysis.
;; **

;; @@
(ns user-analysis
  (:require [gorilla-plot.core :as plot]
            [polismath.db :as db]
            [polismath.intercom :as ic]
            [polismath.pretty-printers :as pp]
            [korma.core :as ko]))
;; @@
;; =>
;;; {"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}
;; <=

;; **
;;; ### First, let's load up the intercom data.
;;; 
;;; Note that at the time of this writing though, we are still getting bad `remote_created_at` attributes in the data everytime someone logs in.
;;; So first, we'll do a mass update, then load the data.
;; **

;; @@
;; WARNING - recompute here!
; (ic/update-intercom-db)
(println "Done with update")
(def icusers (ic/get-icusers))
(println "Done getting icusers")
;; @@
;; ->
;;; Done with update
;;; Done getting icusers
;;; 
;; <-
;; =>
;;; {"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}
;; <=

;; **
;;; Great!
;;; Now let's take a look at the shape here.
;; **

;; @@
(pp/wide-pp (first icusers))
;; @@
;; ->
;;; {&quot;unsubscribed_from_emails&quot; false,
;;;  &quot;segments&quot; {&quot;type&quot; &quot;segment.list&quot;, &quot;segments&quot; [{&quot;type&quot; &quot;segment&quot;, &quot;id&quot; &quot;532c94b472cdbb2586000044&quot;}]},
;;;  &quot;remote_created_at&quot; 1394217883,
;;;  &quot;custom_attributes&quot; {&quot;avg_n_ptpts&quot; nil, &quot;n_owned_convs&quot; nil, &quot;n_ptptd_convs&quot; 1, &quot;n_owned_convs_ptptd&quot; nil, &quot;avg_n_visitors&quot; nil},
;;;  &quot;session_count&quot; 0,
;;;  &quot;created_at&quot; 1394217883,
;;;  &quot;name&quot; &quot;Lang Say&quot;,
;;;  &quot;last_request_at&quot; nil,
;;;  &quot;user_id&quot; &quot;488&quot;,
;;;  &quot;location_data&quot; {},
;;;  &quot;updated_at&quot; 1411322966,
;;;  &quot;user_agent_data&quot; nil,
;;;  &quot;tags&quot; {&quot;type&quot; &quot;tag.list&quot;, &quot;tags&quot; [{&quot;type&quot; &quot;tag&quot;, &quot;id&quot; &quot;16031&quot;, &quot;name&quot; &quot;Starbucks&quot;}]},
;;;  &quot;avatar&quot; {&quot;type&quot; &quot;avatar&quot;, &quot;image_url&quot; nil},
;;;  &quot;app_id&quot; &quot;nb5hla8s&quot;,
;;;  &quot;type&quot; &quot;user&quot;,
;;;  &quot;id&quot; &quot;531a139b93bb867153000edd&quot;,
;;;  &quot;companies&quot; {&quot;type&quot; &quot;company.list&quot;, &quot;companies&quot; []},
;;;  &quot;social_profiles&quot; {&quot;type&quot; &quot;social_profile.list&quot;, &quot;social_profiles&quot; []},
;;;  &quot;email&quot; &quot;lsay@starbucks.com&quot;}
;;; 
;; <-
;; =>
;;; {"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}
;; <=

;; **
;;; And now let's do a deep replacement of string keys with keywords (and replace underscores with dashes).
;; **

;; @@
(defn kwify-key [k]
  (-> k
      (clojure.string/replace "_" "-")
      ; HACK! When I use this to redefine var icusers, it stringifies with :
      (clojure.string/replace ":" "")
      (keyword)))

(defn kwify-hash [h]
  (if (map? h)
    (->> h
         (map (fn [[k v]] [(kwify-key k) (kwify-hash v)]))
         (into {}))
    ; Should come in here later and if coll, iterate over possible maps; don't need yet though
    (if (coll? h)
      (map kwify-hash h)
      h)))

(pp/wide-pp (kwify-hash (first icusers)))
;; @@
;; ->
;;; {:session-count 0,
;;;  :unsubscribed-from-emails false,
;;;  :location-data {},
;;;  :n-ptptd-convs 1,
;;;  :app-id &quot;nb5hla8s&quot;,
;;;  :user-id &quot;488&quot;,
;;;  :name &quot;Lang Say&quot;,
;;;  :user-agent-data nil,
;;;  :companies {:type &quot;company.list&quot;, :companies ()},
;;;  :avatar {:type &quot;avatar&quot;, :image-url nil},
;;;  :custom-attributes {:avg-n-ptpts nil, :n-owned-convs nil, :n-ptptd-convs 1, :n-owned-convs-ptptd nil, :avg-n-visitors nil},
;;;  :email &quot;lsay@starbucks.com&quot;,
;;;  :avg-n-ptpts 0,
;;;  :n-owned-convs-ptptd 0,
;;;  :type &quot;user&quot;,
;;;  :remote-created-at 1394217883,
;;;  :avg-n-visitors 0,
;;;  :n-owned-convs 0,
;;;  :updated-at 1411322966,
;;;  :created-at 1394217883,
;;;  :social-profiles {:type &quot;social_profile.list&quot;, :social-profiles ()},
;;;  :segments {:type &quot;segment.list&quot;, :segments ({:type &quot;segment&quot;, :id &quot;532c94b472cdbb2586000044&quot;})},
;;;  :last-request-at nil,
;;;  :id &quot;531a139b93bb867153000edd&quot;,
;;;  :tags {:type &quot;tag.list&quot;, :tags ({:type &quot;tag&quot;, :id &quot;16031&quot;, :name &quot;Starbucks&quot;})}}
;;; 
;; <-
;; =>
;;; {"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}
;; <=

;; **
;;; Wohoo!
;;; Great.
;;; Now let's build some normalization to a flatter, more focused structure easier to plot and do analysis with.
;;; 
;; **

;; @@
; XXX - For the hash-map-subset, and various plumbing things
(require '[polismath.utils :refer :all]
         '[plumbing.core :as pc])

(defn zeroify-nulls [h]
  (pc/map-vals
    (fn [v] (if v v 0))
    h))

(defn normalize-icuser
  "Grabs only pertinent information; does kwify-hash for you"
  [icuser]
  (as-> icuser user
        (kwify-hash user)
        (-> user
            :custom-attributes
            zeroify-nulls
            (into user))))

(def icusers (map normalize-icuser icusers))
;; @@
;; =>
;;; {"type":"html","content":"<span class='clj-var'>#&#x27;user-analysis/icusers</span>","value":"#'user-analysis/icusers"}
;; <=

;; @@
(first icusers)
;; @@
;; =>
;;; {"type":"list-like","open":"<span class='clj-map'>{</span>","close":"<span class='clj-map'>}</span>","separator":", ","items":[{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:session-count</span>","value":":session-count"},{"type":"html","content":"<span class='clj-unkown'>0</span>","value":"0"}],"value":"[:session-count 0]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:unsubscribed-from-emails</span>","value":":unsubscribed-from-emails"},{"type":"html","content":"<span class='clj-unkown'>false</span>","value":"false"}],"value":"[:unsubscribed-from-emails false]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:location-data</span>","value":":location-data"},{"type":"list-like","open":"<span class='clj-map'>{</span>","close":"<span class='clj-map'>}</span>","separator":", ","items":[],"value":"{}"}],"value":"[:location-data {}]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:n-ptptd-convs</span>","value":":n-ptptd-convs"},{"type":"html","content":"<span class='clj-unkown'>1</span>","value":"1"}],"value":"[:n-ptptd-convs 1]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:app-id</span>","value":":app-id"},{"type":"html","content":"<span class='clj-string'>&quot;nb5hla8s&quot;</span>","value":"\"nb5hla8s\""}],"value":"[:app-id \"nb5hla8s\"]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:user-id</span>","value":":user-id"},{"type":"html","content":"<span class='clj-string'>&quot;488&quot;</span>","value":"\"488\""}],"value":"[:user-id \"488\"]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:name</span>","value":":name"},{"type":"html","content":"<span class='clj-string'>&quot;Lang Say&quot;</span>","value":"\"Lang Say\""}],"value":"[:name \"Lang Say\"]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:user-agent-data</span>","value":":user-agent-data"},{"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}],"value":"[:user-agent-data nil]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:companies</span>","value":":companies"},{"type":"list-like","open":"<span class='clj-map'>{</span>","close":"<span class='clj-map'>}</span>","separator":", ","items":[{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:type</span>","value":":type"},{"type":"html","content":"<span class='clj-string'>&quot;company.list&quot;</span>","value":"\"company.list\""}],"value":"[:type \"company.list\"]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:companies</span>","value":":companies"},{"type":"list-like","open":"<span class='clj-lazy-seq'>(</span>","close":"<span class='clj-lazy-seq'>)</span>","separator":" ","items":[],"value":"()"}],"value":"[:companies ()]"}],"value":"{:type \"company.list\", :companies ()}"}],"value":"[:companies {:type \"company.list\", :companies ()}]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:avatar</span>","value":":avatar"},{"type":"list-like","open":"<span class='clj-map'>{</span>","close":"<span class='clj-map'>}</span>","separator":", ","items":[{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:type</span>","value":":type"},{"type":"html","content":"<span class='clj-string'>&quot;avatar&quot;</span>","value":"\"avatar\""}],"value":"[:type \"avatar\"]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:image-url</span>","value":":image-url"},{"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}],"value":"[:image-url nil]"}],"value":"{:type \"avatar\", :image-url nil}"}],"value":"[:avatar {:type \"avatar\", :image-url nil}]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:custom-attributes</span>","value":":custom-attributes"},{"type":"list-like","open":"<span class='clj-map'>{</span>","close":"<span class='clj-map'>}</span>","separator":", ","items":[{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:avg-n-ptpts</span>","value":":avg-n-ptpts"},{"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}],"value":"[:avg-n-ptpts nil]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:n-owned-convs</span>","value":":n-owned-convs"},{"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}],"value":"[:n-owned-convs nil]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:n-ptptd-convs</span>","value":":n-ptptd-convs"},{"type":"html","content":"<span class='clj-unkown'>1</span>","value":"1"}],"value":"[:n-ptptd-convs 1]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:n-owned-convs-ptptd</span>","value":":n-owned-convs-ptptd"},{"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}],"value":"[:n-owned-convs-ptptd nil]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:avg-n-visitors</span>","value":":avg-n-visitors"},{"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}],"value":"[:avg-n-visitors nil]"}],"value":"{:avg-n-ptpts nil, :n-owned-convs nil, :n-ptptd-convs 1, :n-owned-convs-ptptd nil, :avg-n-visitors nil}"}],"value":"[:custom-attributes {:avg-n-ptpts nil, :n-owned-convs nil, :n-ptptd-convs 1, :n-owned-convs-ptptd nil, :avg-n-visitors nil}]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:email</span>","value":":email"},{"type":"html","content":"<span class='clj-string'>&quot;lsay@starbucks.com&quot;</span>","value":"\"lsay@starbucks.com\""}],"value":"[:email \"lsay@starbucks.com\"]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:avg-n-ptpts</span>","value":":avg-n-ptpts"},{"type":"html","content":"<span class='clj-long'>0</span>","value":"0"}],"value":"[:avg-n-ptpts 0]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:n-owned-convs-ptptd</span>","value":":n-owned-convs-ptptd"},{"type":"html","content":"<span class='clj-long'>0</span>","value":"0"}],"value":"[:n-owned-convs-ptptd 0]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:type</span>","value":":type"},{"type":"html","content":"<span class='clj-string'>&quot;user&quot;</span>","value":"\"user\""}],"value":"[:type \"user\"]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:remote-created-at</span>","value":":remote-created-at"},{"type":"html","content":"<span class='clj-unkown'>1394217883</span>","value":"1394217883"}],"value":"[:remote-created-at 1394217883]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:avg-n-visitors</span>","value":":avg-n-visitors"},{"type":"html","content":"<span class='clj-long'>0</span>","value":"0"}],"value":"[:avg-n-visitors 0]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:n-owned-convs</span>","value":":n-owned-convs"},{"type":"html","content":"<span class='clj-long'>0</span>","value":"0"}],"value":"[:n-owned-convs 0]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:updated-at</span>","value":":updated-at"},{"type":"html","content":"<span class='clj-unkown'>1411322966</span>","value":"1411322966"}],"value":"[:updated-at 1411322966]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:created-at</span>","value":":created-at"},{"type":"html","content":"<span class='clj-unkown'>1394217883</span>","value":"1394217883"}],"value":"[:created-at 1394217883]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:social-profiles</span>","value":":social-profiles"},{"type":"list-like","open":"<span class='clj-map'>{</span>","close":"<span class='clj-map'>}</span>","separator":", ","items":[{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:type</span>","value":":type"},{"type":"html","content":"<span class='clj-string'>&quot;social_profile.list&quot;</span>","value":"\"social_profile.list\""}],"value":"[:type \"social_profile.list\"]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:social-profiles</span>","value":":social-profiles"},{"type":"list-like","open":"<span class='clj-lazy-seq'>(</span>","close":"<span class='clj-lazy-seq'>)</span>","separator":" ","items":[],"value":"()"}],"value":"[:social-profiles ()]"}],"value":"{:type \"social_profile.list\", :social-profiles ()}"}],"value":"[:social-profiles {:type \"social_profile.list\", :social-profiles ()}]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:segments</span>","value":":segments"},{"type":"list-like","open":"<span class='clj-map'>{</span>","close":"<span class='clj-map'>}</span>","separator":", ","items":[{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:type</span>","value":":type"},{"type":"html","content":"<span class='clj-string'>&quot;segment.list&quot;</span>","value":"\"segment.list\""}],"value":"[:type \"segment.list\"]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:segments</span>","value":":segments"},{"type":"list-like","open":"<span class='clj-lazy-seq'>(</span>","close":"<span class='clj-lazy-seq'>)</span>","separator":" ","items":[{"type":"list-like","open":"<span class='clj-map'>{</span>","close":"<span class='clj-map'>}</span>","separator":", ","items":[{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:type</span>","value":":type"},{"type":"html","content":"<span class='clj-string'>&quot;segment&quot;</span>","value":"\"segment\""}],"value":"[:type \"segment\"]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:id</span>","value":":id"},{"type":"html","content":"<span class='clj-string'>&quot;532c94b472cdbb2586000044&quot;</span>","value":"\"532c94b472cdbb2586000044\""}],"value":"[:id \"532c94b472cdbb2586000044\"]"}],"value":"{:type \"segment\", :id \"532c94b472cdbb2586000044\"}"}],"value":"({:type \"segment\", :id \"532c94b472cdbb2586000044\"})"}],"value":"[:segments ({:type \"segment\", :id \"532c94b472cdbb2586000044\"})]"}],"value":"{:type \"segment.list\", :segments ({:type \"segment\", :id \"532c94b472cdbb2586000044\"})}"}],"value":"[:segments {:type \"segment.list\", :segments ({:type \"segment\", :id \"532c94b472cdbb2586000044\"})}]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:last-request-at</span>","value":":last-request-at"},{"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}],"value":"[:last-request-at nil]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:id</span>","value":":id"},{"type":"html","content":"<span class='clj-string'>&quot;531a139b93bb867153000edd&quot;</span>","value":"\"531a139b93bb867153000edd\""}],"value":"[:id \"531a139b93bb867153000edd\"]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:tags</span>","value":":tags"},{"type":"list-like","open":"<span class='clj-map'>{</span>","close":"<span class='clj-map'>}</span>","separator":", ","items":[{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:type</span>","value":":type"},{"type":"html","content":"<span class='clj-string'>&quot;tag.list&quot;</span>","value":"\"tag.list\""}],"value":"[:type \"tag.list\"]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:tags</span>","value":":tags"},{"type":"list-like","open":"<span class='clj-lazy-seq'>(</span>","close":"<span class='clj-lazy-seq'>)</span>","separator":" ","items":[{"type":"list-like","open":"<span class='clj-map'>{</span>","close":"<span class='clj-map'>}</span>","separator":", ","items":[{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:type</span>","value":":type"},{"type":"html","content":"<span class='clj-string'>&quot;tag&quot;</span>","value":"\"tag\""}],"value":"[:type \"tag\"]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:id</span>","value":":id"},{"type":"html","content":"<span class='clj-string'>&quot;16031&quot;</span>","value":"\"16031\""}],"value":"[:id \"16031\"]"},{"type":"list-like","open":"","close":"","separator":" ","items":[{"type":"html","content":"<span class='clj-keyword'>:name</span>","value":":name"},{"type":"html","content":"<span class='clj-string'>&quot;Starbucks&quot;</span>","value":"\"Starbucks\""}],"value":"[:name \"Starbucks\"]"}],"value":"{:type \"tag\", :id \"16031\", :name \"Starbucks\"}"}],"value":"({:type \"tag\", :id \"16031\", :name \"Starbucks\"})"}],"value":"[:tags ({:type \"tag\", :id \"16031\", :name \"Starbucks\"})]"}],"value":"{:type \"tag.list\", :tags ({:type \"tag\", :id \"16031\", :name \"Starbucks\"})}"}],"value":"[:tags {:type \"tag.list\", :tags ({:type \"tag\", :id \"16031\", :name \"Starbucks\"})}]"}],"value":"{:session-count 0, :unsubscribed-from-emails false, :location-data {}, :n-ptptd-convs 1, :app-id \"nb5hla8s\", :user-id \"488\", :name \"Lang Say\", :user-agent-data nil, :companies {:type \"company.list\", :companies ()}, :avatar {:type \"avatar\", :image-url nil}, :custom-attributes {:avg-n-ptpts nil, :n-owned-convs nil, :n-ptptd-convs 1, :n-owned-convs-ptptd nil, :avg-n-visitors nil}, :email \"lsay@starbucks.com\", :avg-n-ptpts 0, :n-owned-convs-ptptd 0, :type \"user\", :remote-created-at 1394217883, :avg-n-visitors 0, :n-owned-convs 0, :updated-at 1411322966, :created-at 1394217883, :social-profiles {:type \"social_profile.list\", :social-profiles ()}, :segments {:type \"segment.list\", :segments ({:type \"segment\", :id \"532c94b472cdbb2586000044\"})}, :last-request-at nil, :id \"531a139b93bb867153000edd\", :tags {:type \"tag.list\", :tags ({:type \"tag\", :id \"16031\", :name \"Starbucks\"})}}"}
;; <=

;; **
;;; OK!
;;; Now let's get down to business and start doing some plotting.
;;; We'll start by creating a little helper function for carrying out the plotting for us.
;; **

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
;; =>
;;; {"type":"vega","content":{"axes":[{"type":"x","scale":"x"},{"type":"y","scale":"y"}],"scales":[{"name":"x","type":"linear","range":"width","zero":false,"domain":{"data":"a48f8797-a049-4649-8c9b-75fa7c246dfa","field":"data.x"}},{"name":"y","type":"linear","range":"height","nice":true,"zero":false,"domain":[0,20]}],"marks":[{"type":"symbol","from":{"data":"a48f8797-a049-4649-8c9b-75fa7c246dfa"},"properties":{"enter":{"x":{"field":"data.x","scale":"x"},"y":{"field":"data.y","scale":"y"},"fill":{"value":"steelblue"},"fillOpacity":{"value":0.3}},"update":{"shape":"circle","size":{"value":20},"stroke":{"value":"transparent"}},"hover":{"size":{"value":60},"stroke":{"value":"white"}}}}],"data":[{"name":"a48f8797-a049-4649-8c9b-75fa7c246dfa","values":[{"x":1394217883,"y":0},{"x":1394218418,"y":0},{"x":1395873111,"y":0},{"x":1396036942,"y":0},{"x":1394564928,"y":0},{"x":1395087096,"y":1},{"x":1395084025,"y":0},{"x":1395089010,"y":0},{"x":1395091899,"y":0},{"x":1395097516,"y":0},{"x":1395264371,"y":0},{"x":1395458598,"y":0},{"x":1397787856,"y":0},{"x":1397792641,"y":0},{"x":1397795847,"y":1},{"x":1397796123,"y":0},{"x":1397798536,"y":0},{"x":1397798630,"y":0},{"x":1397801313,"y":0},{"x":1397804700,"y":0},{"x":1397807335,"y":0},{"x":1397809521,"y":1},{"x":1397821495,"y":0},{"x":1397823287,"y":1},{"x":1397825374,"y":0},{"x":1397829562,"y":0},{"x":1397835950,"y":0},{"x":1397837727,"y":0},{"x":1397839368,"y":1},{"x":1397839372,"y":0},{"x":1397839744,"y":0},{"x":1397840473,"y":1},{"x":1397840724,"y":0},{"x":1397841631,"y":0},{"x":1397842334,"y":0},{"x":1397843450,"y":0},{"x":1397845450,"y":0},{"x":1397848257,"y":0},{"x":null,"y":null},{"x":1397852145,"y":0},{"x":1397852439,"y":2},{"x":1397855737,"y":0},{"x":1397856028,"y":0},{"x":1397856571,"y":0},{"x":1397864528,"y":0},{"x":1397870420,"y":0},{"x":1397871323,"y":0},{"x":1397884094,"y":0},{"x":null,"y":null},{"x":1397889490,"y":0},{"x":1397891200,"y":1},{"x":1397910368,"y":0},{"x":1397922477,"y":0},{"x":1397933896,"y":0},{"x":1397960622,"y":0},{"x":1398037285,"y":0},{"x":1398040091,"y":0},{"x":1398059379,"y":1},{"x":1398068471,"y":0},{"x":1398090313,"y":1},{"x":1398090780,"y":1},{"x":1398115496,"y":1},{"x":1398309749,"y":0},{"x":1400601833,"y":0},{"x":1401072003,"y":1},{"x":1401293202,"y":1},{"x":1401915381,"y":2},{"x":1402493664,"y":0},{"x":null,"y":null},{"x":null,"y":null},{"x":1402950134,"y":0},{"x":1402980088,"y":2},{"x":1403058868,"y":0},{"x":1403058911,"y":0},{"x":1403059077,"y":0},{"x":1403059240,"y":1},{"x":1403116362,"y":0},{"x":1403137362,"y":1},{"x":1403203529,"y":0},{"x":1403267254,"y":2},{"x":null,"y":null},{"x":1403527604,"y":0},{"x":1380495318,"y":53},{"x":1404030909,"y":1},{"x":1404202358,"y":0},{"x":1404774976,"y":0},{"x":1382028798,"y":60},{"x":1392355292,"y":2},{"x":1405011571,"y":1},{"x":1405356781,"y":1},{"x":1385416947,"y":4},{"x":1405383652,"y":5},{"x":1395095614,"y":8},{"x":1405534704,"y":1},{"x":1405721564,"y":0},{"x":1405787737,"y":2},{"x":null,"y":null},{"x":1406120891,"y":0},{"x":1406149597,"y":0},{"x":1406149889,"y":15},{"x":1406152973,"y":0},{"x":1406220380,"y":0},{"x":1406308916,"y":0},{"x":1406620624,"y":2},{"x":1398113399,"y":0},{"x":1406899048,"y":1},{"x":1406916665,"y":1},{"x":1407221921,"y":1},{"x":1407222947,"y":0},{"x":1402557967,"y":6},{"x":1407875492,"y":1},{"x":1408088823,"y":0},{"x":1408090721,"y":0},{"x":1408091561,"y":0},{"x":1408091867,"y":1},{"x":1408092683,"y":0},{"x":1408092926,"y":1},{"x":1408093916,"y":0},{"x":1408094033,"y":0},{"x":1408095113,"y":0},{"x":1408096950,"y":0},{"x":1408098010,"y":2},{"x":1408098271,"y":0},{"x":1408098370,"y":0},{"x":1408100118,"y":0},{"x":1408101244,"y":0},{"x":1408102884,"y":0},{"x":1408112694,"y":0},{"x":1408113602,"y":0},{"x":1408114216,"y":0},{"x":1408116305,"y":0},{"x":1408142844,"y":0},{"x":1408162185,"y":0},{"x":1408165869,"y":0},{"x":1408166896,"y":1},{"x":1408167330,"y":2},{"x":1408174480,"y":0},{"x":1408185398,"y":0},{"x":1408208610,"y":0},{"x":1408208885,"y":0},{"x":1408238057,"y":0},{"x":1408242514,"y":0},{"x":1408272519,"y":1},{"x":1408280251,"y":1},{"x":1408320497,"y":0},{"x":1408320778,"y":0},{"x":1402622201,"y":2},{"x":1408338407,"y":0},{"x":1408378096,"y":0},{"x":1408490683,"y":0},{"x":1392346759,"y":0},{"x":1408655060,"y":0},{"x":1408669115,"y":0},{"x":1408995793,"y":0},{"x":1409083202,"y":0},{"x":1409083935,"y":0},{"x":1409084400,"y":2},{"x":1409085357,"y":0},{"x":1409086212,"y":0},{"x":1409086302,"y":1},{"x":1409087173,"y":1},{"x":1409087711,"y":0},{"x":1409088485,"y":0},{"x":1409088962,"y":0},{"x":1409089668,"y":3},{"x":1409090107,"y":0},{"x":1409090434,"y":0},{"x":1409090562,"y":0},{"x":1409091103,"y":1},{"x":1409091187,"y":0},{"x":1409091437,"y":0},{"x":1409091447,"y":0},{"x":1409091561,"y":0},{"x":1409091748,"y":0},{"x":1409092441,"y":0},{"x":1409092490,"y":1},{"x":1409092966,"y":0},{"x":1409093590,"y":0},{"x":1409094134,"y":0},{"x":1409094366,"y":1},{"x":1409094713,"y":0},{"x":1409095166,"y":1},{"x":1409095399,"y":0},{"x":1409096757,"y":1},{"x":1409096830,"y":0},{"x":1409096833,"y":0},{"x":1409097564,"y":1},{"x":1409098313,"y":0},{"x":1409099091,"y":0},{"x":1409102519,"y":1},{"x":1409103676,"y":0},{"x":1409104454,"y":0},{"x":1409104842,"y":0},{"x":1409104981,"y":0},{"x":1409105293,"y":0},{"x":1409105461,"y":0},{"x":1409105676,"y":1},{"x":1409107107,"y":0},{"x":1409107445,"y":0},{"x":1409108731,"y":0},{"x":1409109334,"y":0},{"x":1409109697,"y":1},{"x":1409111052,"y":0},{"x":1409111545,"y":0},{"x":1409111648,"y":0},{"x":1409111692,"y":0},{"x":1409112065,"y":0},{"x":1409112192,"y":0},{"x":1409112423,"y":0},{"x":1409113365,"y":0},{"x":1409115066,"y":0},{"x":1409116488,"y":0},{"x":1409116718,"y":0},{"x":1409118157,"y":0},{"x":1409118306,"y":0},{"x":1409118616,"y":0},{"x":1409119011,"y":0},{"x":1409119192,"y":0},{"x":1409119431,"y":1},{"x":1409119605,"y":0},{"x":1409120742,"y":0},{"x":1409120784,"y":0},{"x":1409121736,"y":0},{"x":1409124099,"y":2},{"x":1409124343,"y":0},{"x":1409124592,"y":0},{"x":1409124663,"y":0},{"x":1409126268,"y":0},{"x":1409126884,"y":0},{"x":1409127079,"y":0},{"x":1409127852,"y":1},{"x":1409127857,"y":0},{"x":1409131045,"y":1},{"x":1409131653,"y":0},{"x":1409133229,"y":0},{"x":1409133621,"y":0},{"x":1409134444,"y":0},{"x":1409138329,"y":0},{"x":1409138713,"y":0},{"x":1409140516,"y":0},{"x":1409140538,"y":0},{"x":1409141613,"y":0},{"x":1409142358,"y":0},{"x":1409143127,"y":0},{"x":1409145475,"y":0},{"x":1409147469,"y":1},{"x":1409147504,"y":0},{"x":1409149224,"y":0},{"x":1409149247,"y":0},{"x":1409149251,"y":0},{"x":1409150376,"y":0},{"x":1409151934,"y":0},{"x":1409153714,"y":0},{"x":1409156024,"y":0},{"x":1409157388,"y":0},{"x":1409158667,"y":1},{"x":1409158750,"y":0},{"x":1409158839,"y":0},{"x":1409159156,"y":0},{"x":1409159435,"y":0},{"x":1409159915,"y":1},{"x":1409160398,"y":0},{"x":1409160606,"y":0},{"x":1409161478,"y":0},{"x":1409161943,"y":0},{"x":1409162716,"y":0},{"x":1409163039,"y":0},{"x":1409164670,"y":0},{"x":1409165496,"y":0},{"x":1409167317,"y":0},{"x":1409169657,"y":1},{"x":1409170271,"y":1},{"x":1409172332,"y":1},{"x":1409173254,"y":0},{"x":1409173450,"y":0},{"x":1409176914,"y":1},{"x":1409177161,"y":0},{"x":1409177700,"y":1},{"x":1409178866,"y":0},{"x":1409179254,"y":0},{"x":1409180130,"y":0},{"x":1409180660,"y":0},{"x":1409187405,"y":1},{"x":1409192043,"y":0},{"x":1409193882,"y":0},{"x":1409195283,"y":0},{"x":1409198255,"y":0},{"x":1409215423,"y":1},{"x":1409218518,"y":0},{"x":1409222421,"y":0},{"x":1409244562,"y":0},{"x":1409244815,"y":3},{"x":null,"y":null},{"x":1409358312,"y":1},{"x":1409360254,"y":0},{"x":1409439734,"y":0},{"x":1409516985,"y":1},{"x":1409639527,"y":0},{"x":1409643719,"y":0},{"x":1409672505,"y":0},{"x":1409674385,"y":1},{"x":1403378632,"y":2},{"x":1409775891,"y":0},{"x":1409785166,"y":4},{"x":1409799806,"y":0},{"x":1409812953,"y":0},{"x":1409902757,"y":0},{"x":1409937599,"y":0},{"x":1409941879,"y":1},{"x":1409955415,"y":0},{"x":1409970538,"y":0},{"x":1409973115,"y":0},{"x":1409991235,"y":0},{"x":1409994472,"y":0},{"x":1409991480,"y":0},{"x":1409994656,"y":0},{"x":1410015484,"y":0},{"x":1376790638,"y":0},{"x":1410173830,"y":1},{"x":1410223996,"y":0},{"x":1384841630,"y":0},{"x":1410335561,"y":1},{"x":1410383447,"y":0},{"x":1410489181,"y":0},{"x":1410678456,"y":0},{"x":1410882461,"y":0},{"x":1411137752,"y":1},{"x":1411147774,"y":0},{"x":1411147961,"y":0},{"x":null,"y":null},{"x":1411279707,"y":0}]}],"width":400,"height":247.2187957763672,"padding":{"bottom":20,"top":10,"right":10,"left":50}},"value":"#gorilla_repl.vega.VegaView{:content {:axes [{:type \"x\", :scale \"x\"} {:type \"y\", :scale \"y\"}], :scales [{:name \"x\", :type \"linear\", :range \"width\", :zero false, :domain {:data \"a48f8797-a049-4649-8c9b-75fa7c246dfa\", :field \"data.x\"}} {:name \"y\", :type \"linear\", :range \"height\", :nice true, :zero false, :domain [0 20]}], :marks [{:type \"symbol\", :from {:data \"a48f8797-a049-4649-8c9b-75fa7c246dfa\"}, :properties {:enter {:x {:field \"data.x\", :scale \"x\"}, :y {:field \"data.y\", :scale \"y\"}, :fill {:value \"steelblue\"}, :fillOpacity {:value 0.3}}, :update {:shape \"circle\", :size {:value 20}, :stroke {:value \"transparent\"}}, :hover {:size {:value 60}, :stroke {:value \"white\"}}}}], :data [{:name \"a48f8797-a049-4649-8c9b-75fa7c246dfa\", :values ({:x 1394217883, :y 0} {:x 1394218418, :y 0} {:x 1395873111, :y 0} {:x 1396036942, :y 0} {:x 1394564928, :y 0} {:x 1395087096, :y 1} {:x 1395084025, :y 0} {:x 1395089010, :y 0} {:x 1395091899, :y 0} {:x 1395097516, :y 0} {:x 1395264371, :y 0} {:x 1395458598, :y 0} {:x 1397787856, :y 0} {:x 1397792641, :y 0} {:x 1397795847, :y 1} {:x 1397796123, :y 0} {:x 1397798536, :y 0} {:x 1397798630, :y 0} {:x 1397801313, :y 0} {:x 1397804700, :y 0} {:x 1397807335, :y 0} {:x 1397809521, :y 1} {:x 1397821495, :y 0} {:x 1397823287, :y 1} {:x 1397825374, :y 0} {:x 1397829562, :y 0} {:x 1397835950, :y 0} {:x 1397837727, :y 0} {:x 1397839368, :y 1} {:x 1397839372, :y 0} {:x 1397839744, :y 0} {:x 1397840473, :y 1} {:x 1397840724, :y 0} {:x 1397841631, :y 0} {:x 1397842334, :y 0} {:x 1397843450, :y 0} {:x 1397845450, :y 0} {:x 1397848257, :y 0} {:x nil, :y nil} {:x 1397852145, :y 0} {:x 1397852439, :y 2} {:x 1397855737, :y 0} {:x 1397856028, :y 0} {:x 1397856571, :y 0} {:x 1397864528, :y 0} {:x 1397870420, :y 0} {:x 1397871323, :y 0} {:x 1397884094, :y 0} {:x nil, :y nil} {:x 1397889490, :y 0} {:x 1397891200, :y 1} {:x 1397910368, :y 0} {:x 1397922477, :y 0} {:x 1397933896, :y 0} {:x 1397960622, :y 0} {:x 1398037285, :y 0} {:x 1398040091, :y 0} {:x 1398059379, :y 1} {:x 1398068471, :y 0} {:x 1398090313, :y 1} {:x 1398090780, :y 1} {:x 1398115496, :y 1} {:x 1398309749, :y 0} {:x 1400601833, :y 0} {:x 1401072003, :y 1} {:x 1401293202, :y 1} {:x 1401915381, :y 2} {:x 1402493664, :y 0} {:x nil, :y nil} {:x nil, :y nil} {:x 1402950134, :y 0} {:x 1402980088, :y 2} {:x 1403058868, :y 0} {:x 1403058911, :y 0} {:x 1403059077, :y 0} {:x 1403059240, :y 1} {:x 1403116362, :y 0} {:x 1403137362, :y 1} {:x 1403203529, :y 0} {:x 1403267254, :y 2} {:x nil, :y nil} {:x 1403527604, :y 0} {:x 1380495318, :y 53} {:x 1404030909, :y 1} {:x 1404202358, :y 0} {:x 1404774976, :y 0} {:x 1382028798, :y 60} {:x 1392355292, :y 2} {:x 1405011571, :y 1} {:x 1405356781, :y 1} {:x 1385416947, :y 4} {:x 1405383652, :y 5} {:x 1395095614, :y 8} {:x 1405534704, :y 1} {:x 1405721564, :y 0} {:x 1405787737, :y 2} {:x nil, :y nil} {:x 1406120891, :y 0} {:x 1406149597, :y 0} {:x 1406149889, :y 15} {:x 1406152973, :y 0} {:x 1406220380, :y 0} {:x 1406308916, :y 0} {:x 1406620624, :y 2} {:x 1398113399, :y 0} {:x 1406899048, :y 1} {:x 1406916665, :y 1} {:x 1407221921, :y 1} {:x 1407222947, :y 0} {:x 1402557967, :y 6} {:x 1407875492, :y 1} {:x 1408088823, :y 0} {:x 1408090721, :y 0} {:x 1408091561, :y 0} {:x 1408091867, :y 1} {:x 1408092683, :y 0} {:x 1408092926, :y 1} {:x 1408093916, :y 0} {:x 1408094033, :y 0} {:x 1408095113, :y 0} {:x 1408096950, :y 0} {:x 1408098010, :y 2} {:x 1408098271, :y 0} {:x 1408098370, :y 0} {:x 1408100118, :y 0} {:x 1408101244, :y 0} {:x 1408102884, :y 0} {:x 1408112694, :y 0} {:x 1408113602, :y 0} {:x 1408114216, :y 0} {:x 1408116305, :y 0} {:x 1408142844, :y 0} {:x 1408162185, :y 0} {:x 1408165869, :y 0} {:x 1408166896, :y 1} {:x 1408167330, :y 2} {:x 1408174480, :y 0} {:x 1408185398, :y 0} {:x 1408208610, :y 0} {:x 1408208885, :y 0} {:x 1408238057, :y 0} {:x 1408242514, :y 0} {:x 1408272519, :y 1} {:x 1408280251, :y 1} {:x 1408320497, :y 0} {:x 1408320778, :y 0} {:x 1402622201, :y 2} {:x 1408338407, :y 0} {:x 1408378096, :y 0} {:x 1408490683, :y 0} {:x 1392346759, :y 0} {:x 1408655060, :y 0} {:x 1408669115, :y 0} {:x 1408995793, :y 0} {:x 1409083202, :y 0} {:x 1409083935, :y 0} {:x 1409084400, :y 2} {:x 1409085357, :y 0} {:x 1409086212, :y 0} {:x 1409086302, :y 1} {:x 1409087173, :y 1} {:x 1409087711, :y 0} {:x 1409088485, :y 0} {:x 1409088962, :y 0} {:x 1409089668, :y 3} {:x 1409090107, :y 0} {:x 1409090434, :y 0} {:x 1409090562, :y 0} {:x 1409091103, :y 1} {:x 1409091187, :y 0} {:x 1409091437, :y 0} {:x 1409091447, :y 0} {:x 1409091561, :y 0} {:x 1409091748, :y 0} {:x 1409092441, :y 0} {:x 1409092490, :y 1} {:x 1409092966, :y 0} {:x 1409093590, :y 0} {:x 1409094134, :y 0} {:x 1409094366, :y 1} {:x 1409094713, :y 0} {:x 1409095166, :y 1} {:x 1409095399, :y 0} {:x 1409096757, :y 1} {:x 1409096830, :y 0} {:x 1409096833, :y 0} {:x 1409097564, :y 1} {:x 1409098313, :y 0} {:x 1409099091, :y 0} {:x 1409102519, :y 1} {:x 1409103676, :y 0} {:x 1409104454, :y 0} {:x 1409104842, :y 0} {:x 1409104981, :y 0} {:x 1409105293, :y 0} {:x 1409105461, :y 0} {:x 1409105676, :y 1} {:x 1409107107, :y 0} {:x 1409107445, :y 0} {:x 1409108731, :y 0} {:x 1409109334, :y 0} {:x 1409109697, :y 1} {:x 1409111052, :y 0} {:x 1409111545, :y 0} {:x 1409111648, :y 0} {:x 1409111692, :y 0} {:x 1409112065, :y 0} {:x 1409112192, :y 0} {:x 1409112423, :y 0} {:x 1409113365, :y 0} {:x 1409115066, :y 0} {:x 1409116488, :y 0} {:x 1409116718, :y 0} {:x 1409118157, :y 0} {:x 1409118306, :y 0} {:x 1409118616, :y 0} {:x 1409119011, :y 0} {:x 1409119192, :y 0} {:x 1409119431, :y 1} {:x 1409119605, :y 0} {:x 1409120742, :y 0} {:x 1409120784, :y 0} {:x 1409121736, :y 0} {:x 1409124099, :y 2} {:x 1409124343, :y 0} {:x 1409124592, :y 0} {:x 1409124663, :y 0} {:x 1409126268, :y 0} {:x 1409126884, :y 0} {:x 1409127079, :y 0} {:x 1409127852, :y 1} {:x 1409127857, :y 0} {:x 1409131045, :y 1} {:x 1409131653, :y 0} {:x 1409133229, :y 0} {:x 1409133621, :y 0} {:x 1409134444, :y 0} {:x 1409138329, :y 0} {:x 1409138713, :y 0} {:x 1409140516, :y 0} {:x 1409140538, :y 0} {:x 1409141613, :y 0} {:x 1409142358, :y 0} {:x 1409143127, :y 0} {:x 1409145475, :y 0} {:x 1409147469, :y 1} {:x 1409147504, :y 0} {:x 1409149224, :y 0} {:x 1409149247, :y 0} {:x 1409149251, :y 0} {:x 1409150376, :y 0} {:x 1409151934, :y 0} {:x 1409153714, :y 0} {:x 1409156024, :y 0} {:x 1409157388, :y 0} {:x 1409158667, :y 1} {:x 1409158750, :y 0} {:x 1409158839, :y 0} {:x 1409159156, :y 0} {:x 1409159435, :y 0} {:x 1409159915, :y 1} {:x 1409160398, :y 0} {:x 1409160606, :y 0} {:x 1409161478, :y 0} {:x 1409161943, :y 0} {:x 1409162716, :y 0} {:x 1409163039, :y 0} {:x 1409164670, :y 0} {:x 1409165496, :y 0} {:x 1409167317, :y 0} {:x 1409169657, :y 1} {:x 1409170271, :y 1} {:x 1409172332, :y 1} {:x 1409173254, :y 0} {:x 1409173450, :y 0} {:x 1409176914, :y 1} {:x 1409177161, :y 0} {:x 1409177700, :y 1} {:x 1409178866, :y 0} {:x 1409179254, :y 0} {:x 1409180130, :y 0} {:x 1409180660, :y 0} {:x 1409187405, :y 1} {:x 1409192043, :y 0} {:x 1409193882, :y 0} {:x 1409195283, :y 0} {:x 1409198255, :y 0} {:x 1409215423, :y 1} {:x 1409218518, :y 0} {:x 1409222421, :y 0} {:x 1409244562, :y 0} {:x 1409244815, :y 3} {:x nil, :y nil} {:x 1409358312, :y 1} {:x 1409360254, :y 0} {:x 1409439734, :y 0} {:x 1409516985, :y 1} {:x 1409639527, :y 0} {:x 1409643719, :y 0} {:x 1409672505, :y 0} {:x 1409674385, :y 1} {:x 1403378632, :y 2} {:x 1409775891, :y 0} {:x 1409785166, :y 4} {:x 1409799806, :y 0} {:x 1409812953, :y 0} {:x 1409902757, :y 0} {:x 1409937599, :y 0} {:x 1409941879, :y 1} {:x 1409955415, :y 0} {:x 1409970538, :y 0} {:x 1409973115, :y 0} {:x 1409991235, :y 0} {:x 1409994472, :y 0} {:x 1409991480, :y 0} {:x 1409994656, :y 0} {:x 1410015484, :y 0} {:x 1376790638, :y 0} {:x 1410173830, :y 1} {:x 1410223996, :y 0} {:x 1384841630, :y 0} {:x 1410335561, :y 1} {:x 1410383447, :y 0} {:x 1410489181, :y 0} {:x 1410678456, :y 0} {:x 1410882461, :y 0} {:x 1411137752, :y 1} {:x 1411147774, :y 0} {:x 1411147961, :y 0} {:x nil, :y nil} {:x 1411279707, :y 0})}], :width 400, :height 247.2188, :padding {:bottom 20, :top 10, :right 10, :left 50}}}"}
;; <=

;; @@
(doseq [u (take 20 icusers)]
  (println (:social-profiles u)))
;; @@
;; ->
;;; {:type social_profile.list, :social-profiles ()}
;;; {:type social_profile.list, :social-profiles ()}
;;; {:type social_profile.list, :social-profiles ()}
;;; {:type social_profile.list, :social-profiles ({:type social_profile, :name LinkedIn, :id nil, :username nil, :url https://www.linkedin.com/in/scottaklein})}
;;; {:type social_profile.list, :social-profiles ({:type social_profile, :name Picasa, :id nil, :username gabbyarens, :url http://picasaweb.google.com/gabbyarens} {:type social_profile, :name Google Plus, :id 100636434306040192022, :username nil, :url https://plus.google.com/100636434306040192022} {:type social_profile, :name Twitter, :id 921729937, :username GabbyArens, :url http://www.twitter.com/GabbyArens})}
;;; {:type social_profile.list, :social-profiles ({:type social_profile, :name LinkedIn, :id nil, :username nil, :url https://www.linkedin.com/pub/charlie-moore/1/393/116})}
;;; {:type social_profile.list, :social-profiles ()}
;;; {:type social_profile.list, :social-profiles ({:type social_profile, :name Twitter, :id 557452601, :username EmilyLinnDB, :url http://www.twitter.com/EmilyLinnDB} {:type social_profile, :name Facebook, :id 1081980082, :username nil, :url http://facebook.com/1081980082} {:type social_profile, :name Foursquare, :id 21048900, :username nil, :url https://www.foursquare.com/user/21048900} {:type social_profile, :name Klout, :id 103864274393249428, :username EmilyLinnDB, :url http://www.klout.com/user/EmilyLinnDB})}
;;; {:type social_profile.list, :social-profiles ()}
;;; {:type social_profile.list, :social-profiles ()}
;;; {:type social_profile.list, :social-profiles ()}
;;; {:type social_profile.list, :social-profiles ({:type social_profile, :name Facebook, :id 559080603, :username freddymarr, :url http://www.facebook.com/freddymarr} {:type social_profile, :name Twitter, :id 262206426, :username Freddymarr, :url http://www.twitter.com/Freddymarr})}
;;; {:type social_profile.list, :social-profiles ()}
;;; {:type social_profile.list, :social-profiles ({:type social_profile, :name Facebook, :id 100001829575037, :username thegeslist, :url https://www.facebook.com/thegeslist} {:type social_profile, :name Foursquare, :id 45326352, :username nil, :url https://www.foursquare.com/user/45326352} {:type social_profile, :name Angel List, :id 173081, :username gary-shaffer, :url https://angel.co/gary-shaffer} {:type social_profile, :name Twitter, :id 819843234, :username gary_gshafe, :url http://www.twitter.com/gary_gshafe})}
;;; {:type social_profile.list, :social-profiles ({:type social_profile, :name Klout, :id 96264453496773619, :username MrSeanBoyer, :url http://www.klout.com/user/MrSeanBoyer} {:type social_profile, :name Facebook, :id 1525133394, :username sean.boyer.984, :url https://www.facebook.com/sean.boyer.984} {:type social_profile, :name Twitter, :id 425197589, :username MrSeanBoyer, :url http://www.twitter.com/MrSeanBoyer})}
;;; {:type social_profile.list, :social-profiles ({:type social_profile, :name GooglePlus, :id 102414418410649820029, :username nil, :url https://plus.google.com/102414418410649820029} {:type social_profile, :name AngelList, :id 292514, :username robert-7, :url https://angel.co/robert-7} {:type social_profile, :name GoogleProfile, :id 102414418410649820029, :username nil, :url https://profiles.google.com/102414418410649820029/buzz} {:type social_profile, :name Picasa, :id nil, :username nil, :url http://picasaweb.google.com/robert.d.vaillancourt} {:type social_profile, :name Flickr, :id 55791946@N07, :username eastsideallstars, :url https://www.flickr.com/people/55791946@N07} {:type social_profile, :name LinkedIn, :id nil, :username nil, :url https://www.linkedin.com/pub/robert-vaillancourt/48/5b6/128})}
;;; {:type social_profile.list, :social-profiles ()}
;;; {:type social_profile.list, :social-profiles ({:type social_profile, :name Angel List, :id 106848, :username scott-9, :url https://angel.co/scott-9})}
;;; {:type social_profile.list, :social-profiles ()}
;;; {:type social_profile.list, :social-profiles ({:type social_profile, :name Facebook, :id 1226336823, :username sanjeevmrao, :url https://www.facebook.com/sanjeevmrao} {:type social_profile, :name Google Plus, :id 107735257003690698545, :username nil, :url https://plus.google.com/107735257003690698545} {:type social_profile, :name Angel List, :id 81125, :username sanjeev-rao-1, :url https://angel.co/sanjeev-rao-1} {:type social_profile, :name Gravatar, :id 34820475, :username techexecconsulting, :url http://gravatar.com/techexecconsulting} {:type social_profile, :name Twitter, :id 62592620, :username sanjeev_rao, :url http://www.twitter.com/sanjeev_rao})}
;;; 
;; <-
;; =>
;;; {"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}
;; <=

;; **
;;; OK!
;;; This is looking great!
;;; Now we need to go back through here and peice together something that interleavs the social data.
;;; But we're getting close!
;; **

;; @@

;; @@
