(ns polis-storm.online-pca
  (:import [backtype.storm StormSubmitter LocalCluster])
  (:use [backtype.storm clojure config] lamina.core aleph.tcp gloss.core [clojure.data.json :as json]) 
  (:gen-class))

(defspout reaction-spout ["reaction"] {:params [json-server] :prepare true}
  [conf context collector]
  (def incoming-reactions (channel)) 
  (defn handler [ch client-info]
    (siphon ch incoming-reactions))
  (start-tcp-server handler {:port 10000, :frame (string :utf-8)})
    (spout
      (nextTuple []
        (let [json-data (json/read-str @(read-channel incoming-reactions))]         
          ;;(def reactions (apply map vector (json-data :reactions)))
          (def reactions (partition 3 (interleave json-data :reactions)))
          (doseq [reaction reactions]
            (emit-spout! collector [reaction])
         )))
      (ack [id]
      ;;error handling here..requires tuple to have id, do research
      )))

(defbolt pca ["pca"] {:prepare true}
  [conf context collector]
  (let [pca-data ()])         
         )

(defn mk-topology [] 
  (topology
    {"1" (spout-spec (reaction-spout
                    "polis.io/whatever-controller-action") 
                    :p 1)}
     
    {

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
    
