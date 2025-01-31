;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.pythonport
  (:require [cheshire.core :as json]
            [clojure.string :as str]))

(defn serialize-to-json
  "Takes any number of arguments and returns them serialized as a JSON string.
   Arguments can be any Clojure data structure that can be JSON-serialized."
  [& args]
  (json/generate-string (if (= (count args) 1)
                         (first args)
                         args)))

(defn save-to-temp-file
  "Takes any number of arguments, serializes them to JSON, and saves to a temporary file.
   Returns the path to the temporary file.
   For named arguments (passed as keywords), their names will be included in the stdout message."
  [& args]
  (let [temp-file (java.io.File/createTempFile "polis-" ".json")
        file-path (.getAbsolutePath temp-file)
        ;; Extract only the keyword names, skipping the values
        arg-names (->> (partition 2 args)
                      (filter #(keyword? (first %)))
                      (map #(name (first %))))]
    (spit temp-file (apply serialize-to-json args))
    (println (format "saved arguments [%s] to file [%s]"
                    (str/join ", " (if (seq arg-names) arg-names ["unnamed"]))
                    file-path))
    file-path)) 