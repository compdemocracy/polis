(ns conv-man-tests
  (:use polismath.utils
        test-helpers)
  (:require [clojure.test :refer :all]
            [polismath.conv-man :refer :all]))

; Initialization test
(deftest split-batches-test
  (testing "of a missing param"
    (let [messages [[:votes [{:a 4} {:b 5} {:c 6}]]
                    [:votes [{:d 7} {:e 8} {:f 9}]]]]
      (is (= (split-batches messages)
             {:votes [{:a 4} {:b 5} {:c 6} {:d 7} {:e 8} {:f 9}]})))))

