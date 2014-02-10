(ns polismath.play
  (:require [plumbing.core :as plmb]
            [plumbing.graph :as graph])
  (:use clojure.data.csv
        clojure.java.io
        clojure.pprint
        criterium.core
        polismath.conversation
        polismath.clusters
        polismath.pca
        polismath.utils
        polismath.named-matrix
        polismath.simulation))

(def nmat {:rows '[a b c]
           :cols '[x y z v]
           :matrix [[1 0  1 -1]
                    [0 1 -1  1]
                    [1 1 -1  0]]})

(def conv {:rating-mat nmat})

(def results (small-conv-update {:conv conv :opts {}
                             :votes [
                                     {:pid 'a :tid 'x :vote 1}
                                     {:pid 'b :tid 'q :vote 1}
                                     {:pid 'd :tid 'y :vote 1}
                                     ]}))

(def results2 (small-conv-update {:conv results :opts {}
                             :votes [
                                     {:pid 'a :tid 'q :vote -1}
                                     {:pid 'd :tid 'q :vote 0}
                                     {:pid 'd :tid 'x :vote -1}
                                     ]}))

(pprint results)
(pprint results2)

(defn -main []
  (println "Running main"))

