;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns utils-test
  (:require [clojure.test :refer :all]
            [polismath.utils :refer :all]))


(deftest apply-kwargs-test
  (letfn [(fun [a b & {:keys [c d] :as kw-args}]
            {:a a :b b :c c :d d :kw-args kw-args})]
    (let [res (apply-kwargs fun "this" "that" {:c "crap" :d "stuff" :m "more"})]
      (testing "should pass through regular args"
        (is (= (res :a) "this"))
        (is (= (res :b) "that")))
      (testing "should pass through kw-args"
        (is (= (res :c) "crap"))
        (is (= (res :d) "stuff"))
        (is (= ((res :kw-args) :m) "more"))))))


