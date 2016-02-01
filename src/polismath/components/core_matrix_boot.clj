(ns polismath.components.core-matrix-boot
  (:require [polismath.utils :as utils]
            [clojure.core.matrix :as matrix]
            [clojure.tools.logging :as log]
            [com.stuartsierra.component :as component]
            [cheshire.generate :refer [add-encoder encode-seq remove-encoder]]))


(defn matrix-encoder
  [v jsonGenerator]
  (encode-seq (into-array v) jsonGenerator))

(def matrix-types [mikera.vectorz.Vector
                   ;; XXX Need to figure out why this doesn't exist yet
                   clojure.core.matrix.impl.ndarray.NDArray
                   ])

(defrecord CoreMatrixBooter [config]
  component/Lifecycle
  ;; Load the matrix implementation and create a dummy matrix to ensure classes get loaded properly.
  (start [component]
    (let [implementation (get-in config [:math :matrix-implementation])]
      (log/info "Starting CoreMatrixBooter with implementation:" implementation)
      (matrix/set-current-implementation implementation)
      (matrix/matrix [[1 2 3] [4 5 6]])
      ;; Adding encoders so things work properly with serialization
      (doseq [t matrix-types]
        (add-encoder t matrix-encoder)))
    component)

  (stop [component]
    (log/info "Stopping CoreMatrixBooter")
    (doseq [t matrix-types]
      (remove-encoder t))
    component))

(defn create-core-matrix-booter []
  (map->CoreMatrixBooter {}))


:ok

