(ns clojure.tools.cli-legacy-test
  (:use [clojure.string :only [split]]
        [clojure.test :only [deftest is testing]]
        [clojure.tools.cli :as cli :only [cli]]))

(testing "syntax"
  (deftest should-handle-simple-strings
    (is (= {:host "localhost"}
           (first (cli ["--host" "localhost"]
                       ["--host"])))))

  (testing "booleans"
    (deftest should-handle-trues
      (is (= {:verbose true}
             (first (cli ["--verbose"]
                         ["--[no-]verbose"])))))
    (deftest should-handle-falses
      (is (= {:verbose false}
             (first (cli ["--no-verbose"]
                         ["--[no-]verbose"])))))

    (testing "explicit syntax"
      (is (= {:verbose true}
             (first (cli ["--verbose"]
                         ["--verbose" :flag true]))))
      (is (= {:verbose false}
             (first (cli ["--no-verbose"]
                         ["--verbose" :flag true]))))))

  (testing "default values"
    (deftest should-default-when-no-value
      (is (= {:server "10.0.1.10"}
             (first (cli []
                         ["--server" :default "10.0.1.10"])))))
    (deftest should-override-when-supplied
      (is (= {:server "127.0.0.1"}
             (first (cli ["--server" "127.0.0.1"]
                         ["--server" :default "10.0.1.10"])))))
    (deftest should-omit-key-when-no-default
      (is (= false
             (contains? (cli ["--server" "127.0.0.1"]
                             ["--server" :default "10.0.1.10"]
                             ["--names"])
                        :server)))))

  (deftest should-apply-parse-fn
    (is (= {:names ["john" "jeff" "steve"]}
           (first (cli ["--names" "john,jeff,steve"]
                       ["--names" :parse-fn #(vec (split % #","))])))))

  (testing "aliases"
    (deftest should-support-multiple-aliases
      (is (= {:server "localhost"}
             (first (cli ["-s" "localhost"]
                         ["-s" "--server"])))))

    (deftest should-use-last-alias-provided-as-name-in-map
      (is (= {:server "localhost"}
             (first (cli ["-s" "localhost"]
                         ["-s" "--server"]))))))

  (testing "merging args"
    (deftest should-merge-identical-arguments
      (let [assoc-fn (fn [previous key val]
                       (assoc previous key
                              (if-let [oldval (get previous key)]
                                (merge oldval val)
                                (hash-set val))))
            [options args _] (cli ["-p" "1" "--port" "2"]
                                  ["-p" "--port" "description"
                                   :assoc-fn assoc-fn
                                   :parse-fn #(Integer/parseInt %)])]
        (is (= {:port #{1 2}} options)))))

  (testing "extra arguments"
    (deftest should-provide-access-to-trailing-args
      (let [[options args _] (cli ["--foo" "bar" "a" "b" "c"]
                                  ["-f" "--foo"])]
        (is (= {:foo "bar"} options))
        (is (= ["a" "b" "c"] args))))

    (deftest should-work-with-trailing-boolean-args
      (let [[options args _] (cli ["--no-verbose" "some-file"]
                                  ["--[no-]verbose"])]
        (is (= {:verbose false} options))
        (is (= ["some-file"] args))))

    (deftest should-accept-double-hyphen-as-end-of-args
      (let [[options args _] (cli ["--foo" "bar" "--verbose" "--" "file" "-x" "other"]
                                  ["--foo"]
                                  ["--[no-]verbose"])]
        (is (= {:foo "bar" :verbose true} options))
        (is (= ["file" "-x" "other"] args)))))

  (testing "description"
    (deftest should-be-able-to-supply-description
      (let [[options args banner]
            (cli ["-s" "localhost"]
                 "This program does something awesome."
                 ["-s" "--server" :description "Server name"])]
        (is (= {:server "localhost"} options))
        (is (empty? args))
        (is (re-find #"This program does something awesome" banner)))))

  (testing "handles GNU option parsing conventions"
    (deftest should-handle-gnu-option-parsing-conventions
      (is (= (take 2 (cli ["foo" "-abcp80" "bar" "--host=example.com"]
                          ["-a" "--alpha" :flag true]
                          ["-b" "--bravo" :flag true]
                          ["-c" "--charlie" :flag true]
                          ["-h" "--host" :flag false]
                          ["-p" "--port" "Port number"
                           :flag false :parse-fn #(Integer/parseInt %)]))
             [{:alpha true :bravo true :charlie true :port 80 :host "example.com"}
              ["foo" "bar"]])))))

(def normalize-args
  #'cli/normalize-args)

(deftest test-normalize-args
  (testing "expands clumped short options"
    (is (= (normalize-args [] ["-abc" "foo"])
           ["-a" "-b" "-c" "foo"]))
    (is (= (normalize-args [{:switches ["-p"] :flag false}] ["-abcp80" "foo"])
           ["-a" "-b" "-c" "-p" "80" "foo"])))
  (testing "expands long options with assignment"
    (is (= (normalize-args [{:switches ["--port"] :flag false}] ["--port=80" "--noopt=" "foo"])
           ["--port" "80" "--noopt" "" "foo"])))
  (testing "preserves double dash"
    (is (= (normalize-args [] ["-ab" "--" "foo" "-c"])
           ["-a" "-b" "--" "foo" "-c"])))
  (testing "hoists all options and optargs to the front"
    (is (= (normalize-args
             [{:switches ["-x"] :flag false}
              {:switches ["-y"] :flag false}
              {:switches ["--zulu"] :flag false}]
             ["foo" "-axray" "bar" "-by" "yankee" "-c" "baz" "--zulu" "zebra"
              "--" "--full" "stop"])
           ["-a" "-x" "ray" "-b" "-y" "yankee" "-c" "--zulu" "zebra"
            "foo" "bar" "baz" "--" "--full" "stop"]))))

(deftest all-together-now
  (let [[options args _] (cli ["-p" "8080"
                               "--no-verbose"
                               "--log-directory" "/tmp"
                               "--server" "localhost"
                               "filename"]
                              ["-p" "--port" :parse-fn #(Integer/parseInt %)]
                              ["--host" :default "localhost"]
                              ["--[no-]verbose" :default true]
                              ["--log-directory" :default "/some/path"]
                              ["--server"])]
    (is (= {:port 8080
            :host "localhost"
            :verbose false
            :log-directory "/tmp"
            :server "localhost"} options))
    (is (= ["filename"] args))))
