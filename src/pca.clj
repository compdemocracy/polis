(ns pca)

(set! *unchecked-math* true)

(use 'utils 'matrix-utils 'criterium.core)
(require '(incanter
            [core :as ic.core]
            [stats :as ic.stats]
            [datasets :as ic.data]
            [io :as ic.io])
         ;['hiphip.double :as 'dbl]
         ['clojure.tools.trace :as 'tr])
(use 'clojure.tools.trace)


(defn dot [^doubles xs ^doubles ys]
  "Returns the dot (or Euclidean inner) product of vectors xs and ys"
  (ic.core/sum (ic.core/mult xs ys)))


(defn norm [xs]
  "Returns the norm (length) of vector xs"
  (Math/sqrt (apply + (map #(Math/pow % 2) xs))))


(defn repeatv [n x]
  "Utility function for making a vector of length n composed entirely of x"
  (into [] (repeat n x)))


; Should maybe hide this inside power-iteration and have that function wrap it's current
; recursive functionality
(defn xtxr [data start-vec]
  "Will need to rename this and some of the inner variables to be easier to read...
  Computes an inner step of the power-iteration process"
  (let [n-rows (count (first data))
        curr-vec (ic.core/trans (repeatv n-rows 0))]
    (loop [data data curr-vec curr-vec]
      (if-let [row (first data)]
        (recur (rest data)
               (ic.core/plus curr-vec (ic.core/mult (dot row start-vec) row)))
        curr-vec))))


(defn power-iteration [data & [iters start-vector]]
  "This function produces the first eigenvector of data using the power iteration method with
  iters iterations and starting vector start-vector (defaulting to 100 and 111111 resp)."
  ; need to clean up some of these variables names to be more descriptive
  (let [iters (or iters 100)
        n-cols (count (first data))
        start-vector (or start-vector (repeatv n-cols 1))
        ; XXX - this add extra cols to the start vector if we have new comments... should test
        start-vector (into [] (concat start-vector (repeatv (- n-cols (count start-vector)) 1)))]
    (loop [iters iters start-vector start-vector last-eigval 0]
      (let [product-vector (xtxr data start-vector)
            eigval (norm product-vector)
            normed (ic.core/div product-vector eigval)]
        (if (or (= iters 0) (= eigval last-eigval))
          normed
          (recur (dec iters) normed eigval))))))


(defn proj-vec [xs ys]
  "This computes the projection of ys orthogonally onto the vector spanned by xs"
  (let [coeff (/ (dot xs ys) (dot xs xs))]
    (ic.core/mult coeff xs)))


(defn factor-matrix [data xs]
  "As in the Gram-Shmidt process; we can 'factor out' the vector xs from all the vectors in data,
  such that there is no remaining variance in the xs direction within the data."
  (ic.core/matrix (mapv #(ic.core/minus % (proj-vec xs %)) data)))


(defn mean-vector [data]
  (ic.core/matrix (mapv ic.stats/mean (zip data))))


(defn centered-data [data]
  (let [data-cntr (ic.core/trans (mean-vector data))]
    (mapv #(ic.core/minus % data-cntr) data)))


; Will eventually also want to add last-pcs
(defn powerit-pca [data n-comps & {:keys [iters start-vectors]}]
  "Find the first n-comps principal components of the data matrix; iters defaults to iters of
  power-iteration"
  (let [data-cntr (ic.core/trans (mean-vector data))
        cntrd-data (mapv #(ic.core/minus % data-cntr) data)
        start-vectors (or start-vectors [])]
    (loop [data' cntrd-data n-comps' n-comps pcs [] start-vectors start-vectors]
      (let [pc (power-iteration data' iters (first start-vectors)) ; may eventually want to return eigenvals...
            pcs (conj pcs pc)]
        (if (= n-comps' 1)
          pcs ; return if done
          (let [data' (factor-matrix data' pc)
                n-comps' (dec n-comps')]
            (recur data' n-comps' pcs (rest start-vectors))))))))


(defn pca-project [data pcs]
  "Apply the principal component projection specified by pcs to the data"
  ; Here we map each row of data to it's projection
  (mapv
    ; each projection is the map of the pcs to the dot of a pc and the data-row
    (fn [data-row] (mapv #(dot data-row %) pcs))
    data))


