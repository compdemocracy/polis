;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.util.pretty-printers
  ;; Shoud just switch to fipp
  (:require [clojure.pprint :refer :all]))


(defn str-repeat [s n]
  (apply str (repeat n s)))


(defn prindent [base-indent main-indent & other-strings]
  (print (str-repeat " " (* 2 (+ base-indent main-indent))))
  (apply println other-strings))


(defn print-repness [repness & {:keys [indent] :or {indent 0}}]
  (doseq [[gid comments] repness]
    (prindent indent 0 gid)
    (doseq [c comments]
      (prindent indent 2 c))))


(defn wide-pp [x & {:keys [width] :or {width 400}}]
  (binding [*print-miser-width*  width
            *print-right-margin* width]
    (pprint x)))


