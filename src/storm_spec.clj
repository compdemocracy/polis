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
  "This isn't hooked up yet, but I'm hoping we can use something like this for
  abstracting the common pattern of storing/fetching results by conv-id"
  (let [init-fn #(identity nil)]
    (fn [data conv-id & inputs]
      (let [value (or (get data conv-id) (init-fn))
            new-value (apply update-fn value inputs)]
        (assoc data conv-id new-value)))))

(def init-matrix (->RatingMatrix ["p1" "p2" "p3"] ["c1" "c2" "c3"] [[1 1 0] [0 1 -1] [0 -1 1]]))

(defbolt rating-matrix ["conv-id" "rating-matrix"] {:prepare true}
  [conf context collector]
  (let [data (atom {})
        ; This is a function which we can call as a transaction to update our data atom
        update-data (fn [data conv-id reaction]
                      (let [rating-matrix (or (get data conv-id) init-matrix)
                            rating-matrix (update-rating-matrix rating-matrix [reaction])]
                        (assoc data conv-id rating-matrix)))]
    (bolt (execute [tuple]
      (let [[conv-id reaction] (.getValues tuple)]
        (println "RUNNING BOLT")
        (swap! data update-data conv-id reaction)
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
    ;{:pca pca :components components :pc1 pc1 :pc2 pc2 :x1 x1 :x2 x2})))))


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

