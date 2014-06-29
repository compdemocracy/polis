(ns polismath.stormspec
  (:import [backtype.storm StormSubmitter LocalCluster])
  (:use [backtype.storm clojure config]
        polismath.named-matrix
        polismath.simulation)
  (:gen-class))


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


(defbolt conv-update ["conv"] {:prepare true}
  [conf context collector]
  (let [convs (atom {})]
    (bolt (execute [tuple]
      (let [[conv-id reaction] (.getValues tuple)]
        (swap! convs
               (data-updater
                 #(conv-update % [reaction]) hash-map)
                 conv-id)
        (emit-bolt! collector
                    [(get @data conv-id)]
                    :anchor tuple)
        (ack! collector tuple))))))


(defn mk-topology []
  (topology
    ; Spouts:
    {"1" (spout-spec reaction-spout)}
    ; Bolts:
    {"2" (bolt-spec
           {"1"  ["conv-id"]}
           conv-update)}))


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

