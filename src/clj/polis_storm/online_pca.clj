(ns polis-storm.online-pca
  (:import [backtype.storm StormSubmitter LocalCluster])
  (:use [backtype.storm clojure config] [incanter core stats charts] lamina.core aleph.tcp gloss.core [clojure.data.json :as json]) 
  (:gen-class))

(defspout reaction-spout ["reaction"] {:params [json-server] :prepare true}
  [conf context collector]
  (spout
    (nextTuple []
      ;(let [json-data (json/read-str @(read-channel incoming-reactions))]         
      (let [json-data (get (json/read-str (slurp "data/legalization_conv.json")) "reactions")]
        (def reactions (partition 3 (apply interleave (vals json-data))))
        (emit-spout! collector [reactions])
       ))
    (ack [id]
    ;;error handling here..requires tuple to have id, do research
    )))


(defn update-rating-matrix [new-reactions rating-matrix ptpts cmts] 
  (doseq [reaction new-reactions]
    (println "the reaction is : " reaction)
    (if (not (some #(= (nth reaction 0) %) @ptpts))
      (swap! ptpts (conj @ptpts (nth reaction 0))))
    (if (not (some #(= (nth reaction 1) %) @cmts))
      (swap! cmts (conj @cmts (nth reaction 1)))))
  (swap! rating-matrix (map #(into % (repeat (- (count cmts) (count (get rating-matrix 0)) 0)) new-reactions))) 
  (swap! rating-matrix (into rating-matrix (into [] (repeat (- (count ptpts) (count rating-matrix) ) 0))))
  (doseq [reaction new-reactions]
    (let [row (.indexOf cmts (nth reaction 1)) column (.indexOf  (nth reaction 0))]
      (swap! rating-matrix (replace {row (replace {column (nth reaction 2)} (nth rating-matrix row))} rating-matrix)))))  


(defbolt pca ["pca"] {:prepare true}
  [conf context collector]
  (let [rating-matrix (atom (matrix [[]])) ptpts (atom []) cmts (atom [])]         
    (bolt
      (execute [tuple]
        ;;storm tuple impl seems to need some unwrapping
        (def new-reactions (nth (.getValues tuple) 0))
        (update-rating-matrix new-reactions rating-matrix ptpts cmts)       
        (println @rating-matrix)))))

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
    
