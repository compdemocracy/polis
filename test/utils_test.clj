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


