(ns storm-spec
  (:import [backtype.storm StormSubmitter LocalCluster])
  (:require [incanter.core :as ic.core])
  (:use [backtype.storm clojure config]
        matrix-utils
        pca
        [clojure.data.json :as json])
  (:gen-class))



(defn make-reaction-gen [n-convs start-n]
  "This function creates an infinite sequence of reations which models an increasing number of comments and
  people over time, over some number of conversations n-convs. The start-n argument sets the initial number of
  ptpts and cmts per conversation."
  ; I <3 clojure...
  (mapcat
    #(random-reactions % % :n-convs n-convs)
    (map #(+ % start-n) (range))))


(defspout reaction-spout ["conv-id" "reaction"] {:prepare true}
  [conf context collector]
  (let [n-convs 3
        start-n 3
        reaction-gen (atom (make-reaction-gen n-convs start-n))]
    (spout
      (nextTuple []
        (let [reaction (first @reaction-gen)
              conv-id (first reaction)
              rest-reaction (rest reaction)]
          (Thread/sleep 1000)
          (println "RUNNING SPOUT")
          (swap! reaction-gen rest)
          (emit-spout! collector [conv-id rest-reaction])))
      (ack [id]))))


(defn data-updater [update-fn & [init-fn]]
  "This function abstracts the common pattern of fetching (or initing if necessary) an item from a
  data dictionary, then updating it based on the specified updated function. Useful since our bolts
  store data by conversation id."
  (let [init-fn (or init-fn #(identity nil))]
    (fn [data conv-id & inputs]
      (let [value (or (get data conv-id) (init-fn))
            new-value (apply update-fn value inputs)]
        (assoc data conv-id new-value)))))

; This is a little bit of a hack. Need to get pca working on matrices with just a couple of elements still...
(def init-matrix (->RatingMatrix ["p1" "p2" "p3"] ["c1" "c2" "c3"] [[1 1 0] [0 1 -1] [0 -1 1]]))

(defbolt rating-matrix ["conv-id" "rating-matrix"] {:prepare true}
  [conf context collector]
  (let [data (atom {})
    (bolt (execute [tuple]
      (let [[conv-id reaction] (.getValues tuple)]
        (swap! data
               (data-updater #(update-rating-matrix % [reaction]) #(identity init-matrix))
               conv-id)
        (emit-bolt! collector
                    [conv-id (ic.core/matrix (:matrix (get @data conv-id)))]
                    :anchor tuple))))))


(defbolt ptpt-pca ["conv-id" "pcs" "proj"] {:prepare true}
  [conf context collector]
  ; If nothing exists yet, creating an empty matrix
  (let [data (atom {})
        n-comps 2]
    (bolt (execute [tuple]
      (let [[conv-id rating-matrix] (.getValues tuple)]
        (swap! data (data-updater #(powerit-pca rating-matrix n-comps :start-vectors %)) conv-id)
        (let [pcs (get @data conv-id)
              proj (pca-project rating-matrix pcs)]
          (emit-bolt! collector [conv-id pcs proj])))))))


;(defbolt clusters ["clusters"] {:prepare true}
  ;[conf context collector]
  ;(let [


(defn mk-topology []
  (topology
    ; Spouts:
    {"1" (spout-spec reaction-spout)}
    ; Bolts:
    {"2" (bolt-spec {"1"  ["conv-id"]}
                    rating-matrix)
     "3" (bolt-spec {"2" ["conv-id"]}
                    ptpt-pca)
     }))


(defn run-local! []
  (let [cluster (LocalCluster.)]
    (.submitTopology cluster "online-pca" {TOPOLOGY-DEBUG true} (mk-topology))))


(defn submit-topology! [name]
  (StormSubmitter/submitTopology
    name
    {TOPOLOGY-DEBUG true
     TOPOLOGY-WORKERS 3}
    (mk-topology)))


(defn -main
  ([]
   (run-local!))
  ([name]
   (submit-topology! name)))

