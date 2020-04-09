;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns index-hash-test
  (:require [clojure.test :refer :all]
            [polismath.math.named-matrix :refer :all]))


(defn ih-equals [ih1 ih2]
  (letfn [(hash-rep [h] (sort (into [] h)))
          (hash-equal [h1 h2] (= (hash-rep h1) (hash-rep h2)))]
    (and (= (get-names ih1) (get-names ih2))
      (= (hash-equal (.index-hash ih1) (.index-hash ih2))))))


; XXX - should really go through here and clean up not to use .names
(deftest test-index-hash-creation
  (testing "Creating a new index-hash using `index-hash`"
    (testing "with no elements"
      (let [empty-ih (index-hash [])]
        (is (= (.names empty-ih) []))
        (is (= (.index-hash empty-ih) {}))))
    (testing "with some thing"
      (let [ih (index-hash ["this" "that"])]
        (is (= (.names ih) ["this" "that"]))
        (is (= (.index-hash ih) {"this" 0 "that" 1}))))
    (testing "with duplicate things"
      (let [ih (index-hash ["this" "that" "this"])]
        (is (= (.names ih) ["this" "that"]))
        (is (= (.index-hash ih) {"this" 0 "that" 1}))))
    (testing "with another ordering"
      (let [ih (index-hash ["that" "this"])]
        (is (= (.names ih) ["that" "this"]))
        (is (= (.index-hash ih) {"that" 0 "this" 1}))))))

(deftest test-append
  (testing "Appending a new item to the index"
    (let [base (index-hash ["this" "that"])]
      (is (ih-equals (index-hash ["this" "that" "more"]) (append base "more")))
      (testing "when it's already in the index"
        (is (ih-equals base (append base "this")))))))

(deftest test-append-many
  (testing "Appending several items to an index"
    (let [base (index-hash ["this"])
          expected (index-hash ["this" "that" "more"])]
      (is (ih-equals expected (append-many base ["that" "more"])))
      (testing "when some are duplicates"
        (is (ih-equals expected (append-many base ["that" "this" "more" "that"])))))))

(deftest test-subset
  (testing "Creatign a subset"
    (let [base (index-hash ["this" "that" "stuff" "great"])]
      (testing "should give the right stuff"
        (is (ih-equals (index-hash ["this" "stuff"]) (subset base ["this" "stuff"])))))))
