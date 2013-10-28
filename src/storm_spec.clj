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


(def stateful-nonsense [3 3 5])


(defspout reaction-spout ["reaction"] {:params [json-server] :prepare true}
  [conf context collector]
  (spout
    (nextTuple []
      ;(let [json-data (json/read-str @(read-channel incoming-reactions))]
      ;(let [raw-data (slurp "data/legalization_conv.json")
            ;json-data (get (json/read-str raw-data) "reactions")]
      (let [reactions (apply random-reactions stateful-nonsense)]
        (Thread/sleep 2000)
        (println "RUNNING SPOUT")
        (def stateful-nonsense (map + stateful-nonsense [1 1 2]))
        ;(def reactions (partition 3 (apply interleave (vals json-data))))
        (emit-spout! collector [reactions])
       ))
    (ack [id]
    ;;error handling here..requires tuple to have id, do research
    )))


(defbolt pca ["pca"] {:prepare true}
  [conf context collector]
  ; If nothing exists yet, creating an empty matrix
  (let [rating-matrix (atom (->RatingMatrix [] [] [[]]))]
    (bolt
      (execute [tuple]
        ; storm tuple impl needs some unwrapping
        (println "RUNNING BOLT")
        (let [new-reactions (first (.getValues tuple))]
              (swap! rating-matrix update-rating-matrix new-reactions))
        (let [matrix (matrix (:matrix @rating-matrix))
              pca (principal-components matrix)
              components (:rotation pca)
              pc1 (sel components :cols 0)
              pc2 (sel components :cols 1)
              x1 (mmult @rating-matrix pc1)
              x2 (mmult @rating-matrix pc2)]
          {:pca pca :components components :pc1 pc1 :pc2 pc2 :x1 x1 :x2 x2})))))


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

