(ns polismath.play
  (:require [plumbing.core :as plmb]
            [plumbing.graph :as graph]
            [cheshire.core :refer :all]
            [cheshire.generate :refer [add-encoder encode-seq remove-encoder]]
            )
  (:use clojure.data.csv
        clojure.java.io
        clojure.pprint
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
(pprint results)

(add-encoder mikera.vectorz.Vector
             (fn [v jsonGenerator]
               (encode-seq (into-array v) jsonGenerator)))

; CAREFUL - make sure we don't lose dimentions of the N-Dimensional array.
(add-encoder clojure.core.matrix.impl.ndarray.NDArray
             (fn [v jsonGenerator]
               (encode-seq (into-array v) jsonGenerator)))


(pprint (generate-string results))


(defn -main []
  (println "Running main"))

