(ns polismath.play
  (:use clojure.data.csv
        clojure.java.io
        criterium.core
        polismath.pca
        polismath.utils
        polismath.matrix-utils
        polismath.simulation))

(require '(incanter
            [core :as ic.core]
            [stats :as ic.stats]
            [datasets :as ic.data]
            [io :as ic.io]))

(defn -main []
  (let [width  100
        height 50]
    (println width "x" height)
    ; Note that either this needs to be updated to account for how random-reactions works now, or
    ; random-reactions and the reaction generator in the storm spec needs to be updated to be
    ; compatible with this (The reactions expected below are (ptpt, cmt, reaction) triples; currently
    ; random-reactions gives (conv, ptpt, cmt, reaction) 4ples)
    (def reactions (random-reactions width height))
    (def data (ic.core/matrix (:matrix (update-rating-matrix nil reactions))))
    (with-open [wrtr (writer "data.csv")]
      (write-csv wrtr data))
    )
  ;(def data (ic.core/sel (ic.core/to-matrix (ic.data/get-dataset :iris)) :cols (range 4)))
  ;(def data (centered-data data))

  (println "\nComputing powerit-pca")
  (time (def pi-comps (powerit-pca data 2 :iters 300)))
  (println "\nComputing incanter pca")
  (time (def ic-pca (ic.stats/principal-components (ic.core/matrix data))))

  (def pc1 (first pi-comps))
  (println "\nComputing recentered powerit-pca")
  (time (powerit-pca data 2 :start-vectors pi-comps))
)

