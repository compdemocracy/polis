(ns polismath.pca
  (:refer-clojure :exclude [* - + == /])
  (:use polismath.utils
        clojure.core.matrix 
        clojure.core.matrix.stats
        clojure.core.matrix.operators))

(set-current-implementation :vectorz)


(set! *unchecked-math* true)


(defn repeatv [n x]
  "Utility function for making a vector of length n composed entirely of x"
  (matrix (into [] (repeat n x))))


; Should maybe hide this inside power-iteration and have that function wrap it's current
; recursive functionality
(defn xtxr [data start-vec]
  "Will need to rename this and some of the inner variables to be easier to read...
  Computes an inner step of the power-iteration process"
  (let [n-cols (dimension-count data 1)
        curr-vec (transpose (repeatv n-cols 0))]
    (loop [data (rows data) curr-vec curr-vec]
      (if-let [row (first data)]
        (recur (rest data)
               (+ curr-vec (* (inner-product start-vec row) row)))
        curr-vec))))


(defn power-iteration [data & [iters start-vector]]
  "This function produces the first eigenvector of data using the power iteration method with
  iters iterations and starting vector start-vector (defaulting to 100 and 111111 resp)."
  ; need to clean up some of these variables names to be more descriptive
  (let [iters (or iters 100)
        n-cols (count (first data))
        start-vector (or start-vector (repeatv n-cols 1))
        ; XXX - this add extra cols to the start vector if we have new comments... should test
        start-vector (matrix
                       (concat start-vector
                               (repeatv (- n-cols (dimension-count start-vector 0)) 1)))]
    (loop [iters iters start-vector start-vector last-eigval 0]
      (let [product-vector (xtxr data start-vector)
            eigval (length product-vector)
            normed (normalise product-vector)]
        (if (or (= iters 0) (= eigval last-eigval))
          normed
          (recur (dec iters) normed eigval))))))


(defn proj-vec [xs ys]
  "This computes the projection of ys orthogonally onto the vector spanned by xs"
  (let [coeff (/ (dot xs ys) (dot xs xs))]
    (* coeff xs)))


(defn factor-matrix [data xs]
  "As in the Gram-Shmidt process; we can 'factor out' the vector xs from all the vectors in data,
  such that there is no remaining variance in the xs direction within the data."
  (matrix (mapv #(- % (proj-vec xs %)) data)))


(defn centered-data [data]
  (- data (mean data)))


; Will eventually also want to add last-pcs
(defn powerit-pca [data n-comps & {:keys [iters start-vectors]}]
  "Find the first n-comps principal components of the data matrix; iters defaults to iters of
  power-iteration"
  (let [cntrd-data (centered-data data)
        start-vectors (or start-vectors [])
        data-dim (min (row-count cntrd-data) (column-count cntrd-data))]
    (loop [data' cntrd-data n-comps' (min n-comps data-dim) pcs [] start-vectors start-vectors]
      (let [pc (power-iteration data' iters (first start-vectors)) ; may eventually want to return eigenvals...
            pcs (conj pcs pc)]
        (if (= n-comps' 1)
          pcs ; return if done
          (let [data' (factor-matrix data' pc)
                n-comps' (dec n-comps')]
            (recur data' n-comps' pcs (rest start-vectors))))))))


;(defn wrapped-pca [data n-comps & {:keys [iters start-vectors] :as kwargs}]
  ;(let [[row-cnt col-cnt] (dim data)]
    ;(case [(> row-cnt 1) (> col-cnt 1)]
      ;[true true] (apply powerit-pca data n-comps kwargs)


(defn pca-project [data pcs]
  "Apply the principal component projection specified by pcs to the data"
  ; Here we map each row of data to it's projection
  (mmul data (transpose pcs)))


