(ns polismath.components.env
  (:require [environ.core :as environ]))

;; Deprecating... Will remove by the end of refactor XXX

(def ^:dynamic env environ/env)

(defmacro with-env-overrides
  [overrides & body]
  `(binding [env (merge env ~overrides)]
     ~@body))

