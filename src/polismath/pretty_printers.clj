(ns polismath.pretty-printers
  (:require 'clojure.pprint :refer :all))


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


(defn wide-pp [x]
  (binding [*print-miser-width*  400
            *print-right-margin* 400]
    (pprint x)))


