(ns polismath.play
  (:require [plumbing.core :as plmb]
            [plumbing.graph :as graph]
            [cheshire.core :refer :all]
            [cheshire.generate :refer [add-encoder encode-seq remove-encoder]]
            )
  (:use clojure.data.csv
        clojure.java.io
        clojure.pprint
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

(def results (small-conv-update {:conv conv :opts {:group-k 2}
                                 :votes [
                                         {:pid 'a :tid 'x :vote 1}
                                         {:pid 'b :tid 'q :vote 1}
                                         {:pid 'd :tid 'y :vote 1}
                                         ]}))

(def results2 (med-conv-update {:conv results :opts {:group-k 2 :base-k 4}
                                :votes [
                                        {:pid 'e :tid 'q :vote -1}
                                        {:pid 'f :tid 'q :vote 0}
                                        {:pid 'e :tid 'x :vote -1}
                                        ]}))

(pprint results)

(add-encoder mikera.vectorz.Vector
             (fn [v jsonGenerator]
               (encode-seq (into-array v) jsonGenerator)))

; CAREFUL - make sure we don't lose dimensions of the N-Dimensional array.
(add-encoder clojure.core.matrix.impl.ndarray.NDArray
             (fn [v jsonGenerator]
               (encode-seq (into-array v) jsonGenerator)))

(pprint (prep-for-uploading results2))

(pprint (generate-string (prep-for-uploading results2)))


(defn -main []
  (println "Running main"))

