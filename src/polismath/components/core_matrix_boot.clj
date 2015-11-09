(ns polismath.components.core-matrix-boot
  (:require [polismath.utils :as utils]
            [clojure.core.matrix :as matrix]
            [clojure.tools.logging :as log]
            [com.stuartsierra.component :as component]))


(defrecord CoreMatrixBooter [config]
  component/Lifecycle
  ;; Load the matrix implementation and create a dummy matrix to ensure classes get loaded properly.
  (start [component]
    (let [implementation (get-in config [:math :matrix-implementation])]
      (log/info "Starting CoreMatrixBooter with implementation:" implementation)
      (matrix/set-current-implementation implementation)
      (matrix/matrix [[1 2 3] [4 5 6]]))
    component)
  ;; No-op; We can reset the implementation on next start if needed.
  (stop [component]
    component))

(defn create-core-matrix-booter []
  (map->CoreMatrixBooter {}))


:ok

