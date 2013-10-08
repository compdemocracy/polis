(ns polis-storm.online-pca
  (:import [backtype.storm StormSubmitter LocalCluster])
  (:use [backtype.storm clojure config] [incanter [core :exclude [trace]] stats charts] clojure.tools.trace lamina.core aleph.tcp gloss.core [clojure.data.json :as json]) 
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
      (swap! ptpts conj (nth reaction 0)))
    (if (not (some #(= (nth reaction 1) %) @cmts))
      (swap! cmts conj (nth reaction 1))))
  
  (println "expansion collumn diff is : " (- (count @cmts) (count (nth @rating-matrix 0))))
  (println "pre expansion matrix is: " @rating-matrix)
  (reset! rating-matrix (into @rating-matrix (repeat (- (count @ptpts) (count @rating-matrix) ) [])))
  (println "first expansion is : " @rating-matrix)
  (reset! rating-matrix (mapv #(into % (repeat (- (count @cmts) (count %)) 0)) @rating-matrix))
  (println "expansion comment count is : " (count @cmts)) 
  ;(reset! rating-matrix (into @rating-matrix (into [] (repeat (- (count @ptpts) (count @rating-matrix) ) 0))))
  (println "second expansion is : " @rating-matrix)
  ;; maybe could have used map below
  (doseq [reaction new-reactions]
    (let [row (.indexOf @cmts (nth reaction 1)) column (.indexOf @ptpts (nth reaction 0))]
      (println "row is :" row "  column is :" column "  matrix is: " @rating-matrix)
      (swap! rating-matrix assoc-in [row column] (nth reaction 2)) 
      )))  



(defbolt pca ["pca"] {:prepare true}
  [conf context collector]
  (let [rating-matrix (atom [[0]]) ptpts (atom []) cmts (atom [])]         
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
    
