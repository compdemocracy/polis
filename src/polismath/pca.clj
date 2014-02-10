(ns polismath.pca
  (:refer-clojure :exclude [* - + == /])
  (:use polismath.utils
        [clojure.core.match :only (match)]
        clojure.core.matrix 
        clojure.core.matrix.stats
        clojure.core.matrix.operators))

(set-current-implementation :vectorz)
(require '[clojure.tools.trace :as tr])
(use 'alex-and-georges.debug-repl)

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
        n-cols (dimension-count data 1)
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


; Will eventually also want to add last-pcs
(defn powerit-pca [data n-comps & {:keys [iters start-vectors]}]
  "Find the first n-comps principal components of the data matrix; iters defaults to iters of
  power-iteration"
  (let [center (mean data)
        cntrd-data (- data center)
        start-vectors (or start-vectors [])
        data-dim (min (row-count cntrd-data) (column-count cntrd-data))]
    {:center center
     :comps
        (loop [data' cntrd-data n-comps' (min n-comps data-dim) pcs [] start-vectors start-vectors]
          ; may eventually want to return eigenvals...
          ;(debug-repl)
          (let [start-vector (or (first start-vectors)
                                 (matrix (for [x (range (dimension-count data' 1))] (rand))))
                pc (power-iteration data' iters start-vector)
                pcs (conj pcs pc)]
            (if (= n-comps' 1)
              pcs ; return if done
              (let [data' (factor-matrix data' pc)
                    n-comps' (dec n-comps')]
                (recur data' n-comps' pcs (rest start-vectors))))))}))


(defn wrapped-pca [data n-comps & {:keys [iters start-vectors] :as kwargs}]
  ; gracefully handle all of the weird cases
  (match (map (partial dimension-count data) [0 1])
    [1 n-cols]
      {:center (matrix (repeatv n-comps 0))
       :comps  (into [(normalise (get-row data 0))]
                 (repeat (dec n-comps) (repeatv n-cols 0)))}
    [n-rows 1]
      {:center (matrix [0])
       :comps  (matrix [1])}
    :else (apply powerit-pca data n-comps kwargs)))


(defn pca-project [data {:keys [comps center]}]
  "Apply the principal component projection specified by pcs to the data"
  ; Here we map each row of data to it's projection
  ; XXX - still need to verify this...
  (mmul (- data center) (transpose comps)))


