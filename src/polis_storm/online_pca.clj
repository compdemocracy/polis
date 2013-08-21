(ns polis-storm.online-pca
  (:import [backtype.storm StormSubmitter LocalCluster])
  (:use backtype.storm clojure config lamina.core aleph.http [clojure.data.json] :as json)
  (:gen-class))

(defspout reaction-spout ["reaction"] {:params [json-server] :prepare true}
  [conf context collector]
  (let [reactions-channel (http-client {:url json-server})] 
    (spout
      (nextTuple []
        (let [json-data json/read-str @(lamina/read-channel reactions-channel)]         
          ;;(def reactions (apply map vector (json-data :reactions)))
          (def reactions (partition 3 (interleave json-data :reactions)))
            (emit-spout! collector [reaction])
          )))
      (ack [id]
      ;;error handling here..requires tuple to have id, do research
      ))))

(defbolt pca ["pca"] {:prepare true}
  [conf context collector]
  (let [pca-data ()])         
         )
