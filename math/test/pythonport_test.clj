;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns pythonport-test
  (:require [clojure.test :refer :all]
            [polismath.pythonport :as pyport]
            [cheshire.core :as json]
            [clojure.java.io :as io]))

(deftest serialize-to-json-test
  (testing "single argument serialization"
    (let [data {:a 1 :b "test" :c [1 2 3]}
          result (pyport/serialize-to-json data)]
      (is (= data (json/parse-string result true)))))
  
  (testing "multiple argument serialization"
    (let [data1 {:name "test1"}
          data2 [1 2 3]
          data3 42
          result (pyport/serialize-to-json data1 data2 data3)]
      (is (= [data1 data2 data3]
             (json/parse-string result true)))))

  (testing "round-trip serialization with complex nested data"
    (let [complex-data {:string "hello"
                       :number 42
                       :float 3.14159
                       :bool true
                       :null nil
                       :array [1 2 3 "mixed" {:nested true}]
                       :nested {:a {:b {:c "deep"}}}
                       :keywords {:key1 :value1
                                :key2 [:kw1 :kw2 :kw3]}}
          serialized (pyport/serialize-to-json complex-data)
          deserialized (json/parse-string serialized true)
          ;; Expected data after JSON round-trip (keywords become strings)
          expected-data (update-in complex-data [:keywords]
                                 (fn [kw-map]
                                   {:key1 "value1"
                                    :key2 ["kw1" "kw2" "kw3"]}))]
      (is (= expected-data deserialized) "Data should match expected structure after JSON round-trip")
      ;; Test specific data type preservation
      (is (string? (:string deserialized)) "String type should be preserved")
      (is (integer? (:number deserialized)) "Integer type should be preserved")
      (is (float? (:float deserialized)) "Float type should be preserved")
      (is (boolean? (:bool deserialized)) "Boolean type should be preserved")
      (is (nil? (:null deserialized)) "nil should be preserved")
      (is (vector? (:array deserialized)) "Vector type should be preserved")
      (is (map? (:nested deserialized)) "Nested map structure should be preserved"))))

(deftest save-to-temp-file-test
  (testing "file creation and content"
    (let [data {:test "data" :numbers [1 2 3]}
          file-path (pyport/save-to-temp-file data)
          file (io/file file-path)]
      (is (.exists file) "Temp file should exist")
      (is (= data 
             (json/parse-string (slurp file) true))
             "File content should match input data")
      (.delete file)))
  
  (testing "named arguments in output message"
    (let [output (with-out-str 
                  (let [file-path (pyport/save-to-temp-file :config {:port 8080} :data [1 2 3])]
                    (.delete (io/file file-path))))]
      (is (.contains output "config, data") "Output should contain argument names")))
  
  (testing "cleanup after test"
    (let [file-path (pyport/save-to-temp-file "test")]
      (is (not (nil? file-path)) "Should return a file path")
      (let [file (io/file file-path)]
        (is (.delete file) "Should be able to delete the temp file"))))) 