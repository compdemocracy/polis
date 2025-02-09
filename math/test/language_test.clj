;; Testing clojure functionality
(ns language-test
  (:require [clojure.test :refer :all]))

(defn count-up
  "Simple function that counts up from 0 until max-iters is reached.
  This mimics how pca::power-iteration counts the number of iterations"
  [max-iters]
  (loop [iters max-iters
         number-of-body-eval 0]
    (let [new-number-of-body-eval (inc number-of-body-eval)]
      (if (= iters 0)
        ; Important: to mmimic pca::power-iteration, we need to return
        ; the actual "new" number of body-evaluations, i.e. 
        ; how many times the "let" block is evaluated.
        new-number-of-body-eval
        (recur (dec iters) new-number-of-body-eval)))))

(deftest count-up-test
  (testing "Count how many times the body of the loop is evaluated"
    (is (= (count-up 5) 6))
    (is (= (count-up 0) 1))
    (is (= (count-up 1) 2)))) 