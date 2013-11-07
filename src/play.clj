(ns play)

(use 'clojure.data.csv
     'clojure.java.io
     'pca
     'utils
     'matrix-utils)

(require '(incanter
            [core :as ic.core]
            [stats :as ic.stats]
            [datasets :as ic.data]
            [io :as ic.io]))

(defn -main []
  (let [width  100
        height 50]
    (println width "x" height)
    (def reactions (random-reactions width height))
    (def data (ic.core/matrix (:matrix (update-rating-matrix nil reactions))))
    (with-open [wrtr (writer "data.csv")]
      (write-csv wrtr data))
    )
  ;(def data (ic.core/sel (ic.core/to-matrix (ic.data/get-dataset :iris)) :cols (range 4)))
  ;(def data (centered-data data))

  (println "Computing powerit-pca")
  (time (def pi-comps (powerit-pca data 2 :iters 300)))
  (println "Computing incanter pca")
  (time (def ic-pca (ic.stats/principal-components (ic.core/matrix data))))

  (def pc1 (first pi-comps))
  (println "Computing recentered powerit-pca")
  (time (def pi-comps (powerit-pca data 2 :start-vectors pi-comps)))
  (def pc1' (first pi-comps))
  (println "Dot" (dot pc1 pc1'))
  (time (def pi-comps (powerit-pca data 2 :start-vectors pi-comps)))
)

