(ns polismath.env
  (:require [environ.core :as environ]))

(def ^:dynamic env environ/env)

(defmacro with-env-overrides
  [overrides & body]
  `(binding [env (merge env ~overrides)]
     ~@body))

