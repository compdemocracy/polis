(ns storm-spec
  (:import [backtype.storm StormSubmitter LocalCluster])
  (:use [backtype.storm clojure config]
        [incanter [core :exclude [trace]] stats charts]
        clojure.tools.trace
        lamina.core aleph.tcp
        gloss.core
        matrix-utils
        [clojure.data.json :as json])
  (:gen-class))


(def n-convs 3)


; This simulates reactions coming in from a bunch of different sources, one reaction at a time
(defn reaction-gen [start]
  (mapcat
    #(random-reactions % % :n-convs n-convs)
    (map #(+ % start) (range))))


(def reaction-gen-atom (atom (reaction-gen 3)))


(defspout reaction-spout ["conv-id" "reaction"]
  [conf context collector]
  (spout
    (nextTuple []
      (let [reaction (first @reaction-gen-atom)
            conv-id (first reaction)
            rest-reaction (rest reaction)]
        (Thread/sleep 1000)
        (println "RUNNING SPOUT")
        (swap! reaction-gen-atom rest)
        (emit-spout! collector [conv-id rest-reaction])))
    (ack [id])))


(defn data-updater [update-fn init-fn]
  (fn [data conv-id inputs]
    (let [value (or (get data conv-id) (init-fn))]
      (update-fn value inputs))))


(defbolt rating-matrix ["conv-id" "rating-matrix"] {:prepare true}
  [conf context collector]
  (let [data (atom {})
        ; This is a function which we can call as a transaction to update our data atom
        update-data (fn [data conv-id reaction]
                      (let [rating-matrix (or (get data conv-id) (->RatingMatrix [] [] [[]]))
                            rating-matrix (update-rating-matrix rating-matrix [reaction])]
                        (assoc data conv-id rating-matrix)))]
    (bolt (execute [tuple]
      (let [[conv-id reaction] (.getValues tuple)]
        (println "RUNNING BOLT")
        (swap! data update-data conv-id reaction)
        (emit-bolt! collector
                    [conv-id (:matrix (get @data conv-id))]
                    :anchor tuple))))))


(defn mk-topology []
  (topology
    ; Spouts:
    {"1" (spout-spec reaction-spout)}
    ; Bolts:
    {"2" (bolt-spec {"1"  ["conv-id"]}
                    rating-matrix
                    :p 1)
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

