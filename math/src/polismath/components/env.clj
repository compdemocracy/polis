;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.components.env
  (:require [environ.core :as environ]))

;; Deprecating... Will remove by the end of refactor XXX

(def ^:dynamic env environ/env)

(defmacro with-env-overrides
  [overrides & body]
  `(binding [env (merge env ~overrides)]
     ~@body))

