;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.components.core-matrix-boot
  (:require [polismath.utils :as utils]
            [clojure.core.matrix :as matrix]
            [clojure.core.matrix.impl.ndarray :as ndarray]
            [taoensso.timbre :as log]
            [com.stuartsierra.component :as component]
            [cheshire.generate :refer [add-encoder encode-seq remove-encoder]]))


;; Maybe this just shouldn't be a component, but an environment thing? Or does it work cause things won't be loaded on
;; static compile anyway? Ug...

(defn matrix-encoder
  [v jsonGenerator]
  (encode-seq (into-array v) jsonGenerator))

;; Should maybe make this dynamically computed based on the implementation... Annoying that we have to do this at all;
;; Maybe there is something better we can hook on in our json encoding multimethod (the reason we
;; need any of this mess)
(def matrix-types ['mikera.vectorz.Vector
                   ;; XXX Need to figure out why this doesn't exist yet
                   ;'clojure.core.matrix.impl.ndarray.NDArray])
                   ;; Could this be the new ns?
                   'mikera.arrayz.NDArray
                   'mikera.matrixx.Matrix
                   ;'clojure.core.matrix.impl.ndarray.NDArray
                   'clojure.core.matrix.impl.ndarray_object.NDArray])


(def dummy-matrix [[1 2 3] [4 5 6]])

(defrecord CoreMatrixBooter [config]
  component/Lifecycle
  ;; Load the matrix implementation and create a dummy matrix to ensure classes get loaded properly.
  (start [component]
    (let [implementation (get-in config [:math :matrix-implementation])]
      (log/info ">> Starting CoreMatrixBooter with implementation:" implementation)
      (matrix/matrix dummy-matrix)
      (matrix/set-current-implementation implementation)
      (matrix/matrix dummy-matrix)
      ;(matrix/matrix :ndarray-object dummy-matrix)
      (matrix/matrix :ndarray-double dummy-matrix)
      (matrix/matrix :ndarray dummy-matrix)
      ;; Adding encoders so things work properly with serialization
      ;(require '[clojure.core.matrix.impl.ndarray])
      (doseq [t matrix-types]
        (add-encoder (ns-resolve *ns* t) matrix-encoder)))
    component)

  (stop [component]
    (log/info "<< Stopping CoreMatrixBooter")
    ;; Actually... let's just stop this.
    ;(doseq [t matrix-types]
    ;  (remove-encoder (ns-resolve *ns* t)))
    component))

(defn create-core-matrix-booter
  ([]
   (create-core-matrix-booter {}))
  ([options]
   (map->CoreMatrixBooter options)))


;(component/start (create-core-matrix-booter {:config {:math {:matrix-implementation :vectorz}}}))

:ok

