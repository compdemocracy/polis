(ns pca)

(require ['clojure.tools.trace :as 'tr])


(defn mean [xs]
  "Returns the mean of vector xs"
  (/ (apply + xs) (count xs)))


(defn dot [xs ys]
  "Returns the dot (or Euclidean inner) product of vectors xs and ys"
  (reduce + (map * xs ys)))


(defn v+ [xs ys]
  "Vector addition function"
  (mapv + xs ys))


(defn v- [xs ys]
  "Vector subtraction function"
  (mapv - xs ys))


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
        curr-vec (repeatv n-rows 0)]
    (loop [data data curr-vec curr-vec]
      (if-let [row (first data)]
        (recur (rest data)
               (v+ curr-vec (mapv #(* (dot row start-vec) %) row)))
        curr-vec))))


(defn power-iteration [data & [iters start-vector]]
  "This function produces the first eigenvector of data using the power iteration method with
  iters iterations and starting vector start-vector (defaulting to 100 and 111111 resp)."
  ; need to clean up some of these variables names to be more descriptive
  (let [iters (or iters 100)
        n-rows (count (first data))
        start-vector (or start-vector (repeatv n-rows 1))]
    (loop [data data iters iters start-vector start-vector]
      (if (> iters 0)
        (let [product-vector (xtxr data start-vector)
              eigen-val (norm product-vector)
              normed (mapv #(/ % eigen-val) product-vector)]
          (recur data (dec iters) normed))
        start-vector))))


(defn proj-vec [xs ys]
  "This computes the projection of ys orthogonally onto the vector spanned by xs"
  (let [coeff (/ (dot xs ys) (dot xs xs))]
    (mapv #(* coeff %) xs)))


(defn factor-matrix [data xs]
  "As in the Gram-Shmidt process; we can 'factor out' the vector xs from all the vectors in data,
  such that there is no remaining variance in the xs direction within the data."
  (mapv #(v- % (proj-vec xs %)) data))


; Will eventually also want to add last-pcs
(defn powerit-pca [data n-comps & [iters]]
  "Find the first n-comps principal components of the data matrix; iters defaults to iters of
  power-iteration"
  (letfn [(inner-fn [data' n-comps' pcs]
            (let [pc (power-iteration data' iters) ; may eventually want to return eigenvals...
                  pcs (conj pcs pc)]
              (if (= n-comps' 1)
                pcs ; return if done
                (let [data' (factor-matrix data' pc)
                      n-comps' (dec n-comps')]
                  (recur data' n-comps' pcs)))))]
    (inner-fn data n-comps [])))


(defn pca-project [data pcs]
  "Apply the principal component projection specified by pcs to the data"
  ; Here we map each row of data to it's projection
  (mapv
    ; each projection is the map of the pcs to the dot of a pc and the data-row
    (fn [data-row] (mapv #(dot data-row %) pcs))
    data))


; Note this isn't safe if E[xy] ~= E[x]E[y]; should eventually replace
(defn cov [xs ys]
  (- (mean (map * xs ys))
     (* (mean xs) (mean ys))))


(def data
  [[1  0 0  1  1 -1  1 -1]
   [0 -1 0  1 -1 -1 -1 -1]
   [1  1 0 -1  0 -1 -1  1]
   [-1 0 1  1 -1  0  1  1]])




(time (def components (powerit-pca data 2)))
(println components)
(println (dot (first components) (last components)))

(use '(incanter core stats))
(time (def pca (principal-components (matrix data))))
(println pca)
(def components (:rotation pca))
(println components)
(def pc1 (into [] (sel components :cols 0)))
(def pc2 (into [] (sel components :cols 1)))
(println [pc1 pc2])
(println (dot pc1 pc2))

(println (dot pc1 (first components)))
(println (dot pc2 (last components)))

(println (dot (first components) (first components)))
(println (dot pc1 pc1))

(defn cov-mat [mat]
  (mapv (fn [row1]
         (mapv (fn [row2] (cov row1 row2)) mat)) mat))

