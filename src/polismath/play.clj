(ns polismath.play
  (:require [plumbing.core :as plmb]
            [plumbing.graph :as graph])
  (:use clojure.data.csv
        clojure.java.io
        criterium.core
        polismath.conversation
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

(def small-conv-update (graph/eager-compile small-conv-update-graph))

(def results (small-conv-update {:conv conv :opts {}
                             :votes [
                                     {:pid 'a :tid 'x :vote 1}
                                     {:pid 'b :tid 'q :vote 1}
                                     {:pid 'd :tid 'y :vote 1}
                                     ]}))

(println results)

(defn -main []
  (println "Running main"))

