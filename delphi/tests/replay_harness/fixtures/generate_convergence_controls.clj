;; Run from math: clojure -M ../delphi/tests/replay_harness/fixtures/generate_convergence_controls.clj OUTPUT.json
;; Test-only controls from the actual Vector dispatch used by cluster centers.
(require '[clojure.core.matrix :as m]
         '[polismath.math.clusters :as c]
         '[cheshire.core :as json])
(m/set-current-implementation :vectorz)
(def cases
  (concat
    [{:name "large-coordinate-cancellation" :left [1.0e8 1.0e8] :right [100000000.02 1.0e8]}
     {:name "ordinary-below" :left [4.0 -3.0] :right [4.009 -3.0]}
     {:name "ordinary-above" :left [4.0 -3.0] :right [4.011 -3.0]}
     {:name "threshold-equality" :left [0.0 0.0] :right [0.01 0.0]}
     {:name "threshold-below" :left [0.0 0.0] :right [(Math/nextDown 0.01) 0.0]}
     {:name "threshold-above" :left [0.0 0.0] :right [(Math/nextUp 0.01) 0.0]}
     {:name "both-coordinates" :left [0.0 0.0] :right [0.006 0.008]}
     {:name "coincident" :left [2.0 -3.0] :right [2.0 -3.0]}
     {:name "signed-zero" :left [-0.0 0.0] :right [0.0 -0.0]}
     {:name "square-underflow" :left [0.0 0.0] :right [1.0e-200 -1.0e-200]}
     {:name "square-overflow" :left [0.0 0.0] :right [1.0e200 -1.0e200]}
     {:name "nan-coordinate" :left ["NaN" 0.0] :right [0.0 0.0]}
     {:name "equal-infinities" :left ["Infinity" 0.0] :right ["Infinity" 0.0]}]
    (for [n [2 3 7 17 64] scale [1.0e-8 1.0 1.0e8]]
      {:name (str "ordered-" n "-" scale)
       :left (mapv #(* scale (+ 1.0 (/ % 7.0))) (range n))
       :right (mapv #(+ (* scale (+ 1.0 (/ % 7.0))) (* 0.003 (inc (mod % 3)))) (range n))})
    [{:name "ordered-small-tail" :left (vec (repeat 17 0.0))
      :right (into [1.0] (repeat 16 1.0e-8))}]))
(defn number-value [x] (if (string? x) (Double/parseDouble x) (double x)))
(defn control [{:keys [left right] :as input}]
  (let [x (m/matrix (mapv number-value left))
        y (m/matrix (mapv number-value right))
        distance (double (m/distance x y))
        thresholds (if (Double/isFinite distance)
                     [0.01 (Math/nextDown distance) distance (Math/nextUp distance)]
                     [0.01])]
    (assert (= mikera.vectorz.Vector (type x) (type y)))
    (assoc input
      :center-class (.getName (class x))
      :distance-hex (Double/toHexString distance)
      :checks (mapv (fn [threshold]
                      {:threshold-hex (Double/toHexString threshold)
                       :same (c/same-clustering? [{:center x}] [{:center y}] :threshold threshold)})
                    thresholds))))
(spit (first *command-line-args*) (str (json/generate-string (mapv control cases) {:pretty true}) "\n"))
(shutdown-agents)
