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

(defspout reaction-spout ["reaction"] {:params [json-server] :prepare true}
  [conf context collector]
  (spout
    (nextTuple []
      ;(let [json-data (json/read-str @(read-channel incoming-reactions))]         
      (let [raw-data (slurp "data/legalization_conv.json")
            json-data (get (json/read-str raw-data) "reactions")]
        (Thread/sleep 20000)
        (def reactions (partition 3 (apply interleave (vals json-data))))
        (emit-spout! collector [reactions])
       ))
    (ack [id]
    ;;error handling here..requires tuple to have id, do research
    )))


(defbolt pca ["pca"] {:prepare true}
  [conf context collector]
  (let [rating-matrix (atom [[0]])
        ptpts (atom [])
        cmts (atom [])]         
    (bolt
      (execute [tuple]
        ;;storm tuple impl seems to need some unwrapping
        (def new-reactions (nth (.getValues tuple) 0))
        (update-rating-matrix new-reactions rating-matrix ptpts cmts)       
        (println "complete, RM is " @rating-matrix)
        (def pca (principal-components @rating-matrix))
        (def components (:rotation pca))
        (def pc1 (sel components :cols 0))
        (def pc2 (sel components :cols 1)) 
        (def x1 (mmult @rating-matrix pc1)) 
        (def x2 (mmult @rating-matrix pc2)) 
        (view (scatter-plot x1 x2 
          :x-label "PC1" 
          :y-label "PC2" 
          :title "legalization_conv"))))))


(defn mk-topology [] 
  (topology
    {"1" (spout-spec (reaction-spout
                     "polis.io/whatever-controller-action") 
                    :p 1)}
     
    {"2" (bolt-spec {"1" :all}
                    pca
                    :p 1)}))


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
    
