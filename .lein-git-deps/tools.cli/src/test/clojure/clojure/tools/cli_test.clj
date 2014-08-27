(ns ^{:cljs 'cljs.tools.cli-test} clojure.tools.cli-test
  ^{:cljs
    '(:require [cljs.tools.cli :as cli :refer [get-default-options parse-opts summarize]]
               [clojure.string :refer [join]]
               cemerick.cljs.test)}
  (:use [clojure.tools.cli :as cli :only [get-default-options parse-opts summarize]]
        [clojure.string :only [join]]
        [clojure.test :only [deftest is testing]])
  #_(:cljs (:require-macros [cemerick.cljs.test :refer [deftest is testing]])))

;; Refer private vars
(def tokenize-args        (^{:cljs 'do} var cli/tokenize-args))
(def compile-option-specs (^{:cljs 'do} var cli/compile-option-specs))
(def parse-option-tokens  (^{:cljs 'do} var cli/parse-option-tokens))

(deftest test-tokenize-args
  (testing "expands clumped short options"
    (is (= (tokenize-args #{"-p"} ["-abcp80"])
           [[[:short-opt "-a"] [:short-opt "-b"] [:short-opt "-c"] [:short-opt "-p" "80"]] []])))
  (testing "detects arguments to long options"
    (is (= (tokenize-args #{"--port" "--host"} ["--port=80" "--host" "example.com"])
           [[[:long-opt "--port" "80"] [:long-opt "--host" "example.com"]] []]))
    (is (= (tokenize-args #{} ["--foo=bar" "--noarg=" "--bad =opt"])
           [[[:long-opt "--foo" "bar"] [:long-opt "--noarg" ""] [:long-opt "--bad =opt"]] []])))
  (testing "stops option processing on double dash"
    (is (= (tokenize-args #{} ["-a" "--" "-b"])
           [[[:short-opt "-a"]] ["-b"]])))
  (testing "finds trailing options unless :in-order is true"
    (is (= (tokenize-args #{} ["-a" "foo" "-b"])
           [[[:short-opt "-a"] [:short-opt "-b"]] ["foo"]]))
    (is (= (tokenize-args #{} ["-a" "foo" "-b"] :in-order true)
           [[[:short-opt "-a"]] ["foo" "-b"]])))
  (testing "does not interpret single dash as an option"
    (is (= (tokenize-args #{} ["-"]) [[] ["-"]]))))

(deftest test-compile-option-specs
  (testing "does not set values for :default unless specified"
    (is (= (map #(contains? % :default) (compile-option-specs
                                          [["-f" "--foo"]
                                           ["-b" "--bar=ARG" :default 0]]))
           [false true])))
  (testing "interprets first three string arguments as short-opt, long-opt=required, and desc"
    (is (= (map (juxt :short-opt :long-opt :required :desc)
                (compile-option-specs [["-a" :id :alpha]
                                       ["-b" "--beta"]
                                       [nil nil "DESC" :id :gamma]
                                       ["-f" "--foo=FOO" "desc"]]))
           [["-a" nil nil nil]
            ["-b" "--beta" nil nil]
            [nil nil nil "DESC"]
            ["-f" "--foo" "FOO" "desc"]])))
  (testing "throws AssertionError on unset :id, duplicate :short-opt or :long-opt,
            or multiple :default entries per :id"
    (is (thrown? ^{:cljs js/Error} AssertionError
                 (compile-option-specs [["-a" :id nil]])))
    (is (thrown? ^{:cljs js/Error} AssertionError
                 (compile-option-specs [{:id :a :short-opt "-a"} {:id :b :short-opt "-a"}])))
    (is (thrown? ^{:cljs js/Error} AssertionError
                 (compile-option-specs [{:id :alpha :long-opt "--alpha"} {:id :beta :long-opt "--alpha"}])))
    (is (thrown? ^{:cljs js/Error} AssertionError
                 (compile-option-specs [{:id :alpha :default 0} {:id :alpha :default 1}]))))
  (testing "desugars `--long-opt=value`"
    (is (= (map (juxt :id :long-opt :required)
                (compile-option-specs [[nil "--foo FOO"] [nil "--bar=BAR"]]))
           [[:foo "--foo" "FOO"]
            [:bar "--bar" "BAR"]])))
  (testing "desugars :validate [fn msg]"
    (let [port? #(< 0 % 0x10000)]
      (is (= (map (juxt :validate-fn :validate-msg)
                  (compile-option-specs
                    [[nil "--name NAME" :validate [seq "Must be present"]]
                     [nil "--port PORT" :validate [integer? "Must be an integer"
                                                   port? "Must be between 0 and 65536"]]
                     [:id :back-compat
                      :validate-fn identity
                      :validate-msg "Should be backwards compatible"]]))
             [[[seq] ["Must be present"]]
              [[integer? port?] ["Must be an integer" "Must be between 0 and 65536"]]
              [[identity] ["Should be backwards compatible"]]]))))
  (testing "accepts maps as option specs without munging values"
    (is (= (compile-option-specs [{:id ::foo :short-opt "-f" :long-opt "--foo"}])
           [{:id ::foo :short-opt "-f" :long-opt "--foo"}])))
  (testing "warns about unknown keys"
    (^{:cljs 'do} when ^{:clj true} *assert*
      (is (re-find #"Warning:.* :flag"
                   (with-out-str
                     (binding ^{:cljs []} [*err* *out*]
                       (compile-option-specs [[nil "--alpha" :validate nil :flag true]])))))
      (is (re-find #"Warning:.* :validate"
                   (with-out-str
                     (binding ^{:cljs []} [*err* *out*]
                       (compile-option-specs [{:id :alpha :validate nil}]))))))))

(defn has-error? [re coll]
  (seq (filter (partial re-seq re) coll)))

(defn parse-int [x]
  ^{:cljs (do (assert (re-seq #"^\d" x))
              (js/parseInt x))}
  (Integer/parseInt x))

(deftest test-parse-option-tokens
  (testing "parses and validates option arguments"
    (let [specs (compile-option-specs
                  [["-p" "--port NUMBER"
                    :parse-fn parse-int
                    :validate [#(< 0 % 0x10000) "Must be between 0 and 65536"]]
                   ["-f" "--file PATH"
                    :validate [#(not= \/ (first %)) "Must be a relative path"
                               ;; N.B. This is a poor way to prevent path traversal
                               #(not (re-find #"\.\." %)) "No path traversal allowed"]]
                   ["-q" "--quiet"
                    :id :verbose
                    :default true
                    :parse-fn not]])]
      (is (= (parse-option-tokens specs [[:long-opt "--port" "80"] [:short-opt "-q"]])
             [{:port (int 80) :verbose false} []]))
      (is (has-error? #"Unknown option"
                      (peek (parse-option-tokens specs [[:long-opt "--unrecognized"]]))))
      (is (has-error? #"Missing required"
                      (peek (parse-option-tokens specs [[:long-opt "--port"]]))))
      (is (has-error? #"Must be between"
                      (peek (parse-option-tokens specs [[:long-opt "--port" "0"]]))))
      (is (has-error? #"Error while parsing"
                      (peek (parse-option-tokens specs [[:long-opt "--port" "FOO"]]))))
      (is (has-error? #"Must be a relative path"
                      (peek (parse-option-tokens specs [[:long-opt "--file" "/foo"]]))))
      (is (has-error? #"No path traversal allowed"
                      (peek (parse-option-tokens specs [[:long-opt "--file" "../../../etc/passwd"]]))))))
  (testing "merges values over default option map"
    (let [specs (compile-option-specs
                  [["-a" "--alpha"]
                   ["-b" "--beta" :default false]
                   ["-g" "--gamma=ARG"]
                   ["-d" "--delta=ARG" :default "DELTA"]])]
      (is (= (parse-option-tokens specs [])
             [{:beta false :delta "DELTA"} []]))
      (is (= (parse-option-tokens specs [[:short-opt "-a"]
                                         [:short-opt "-b"]
                                         [:short-opt "-g" "GAMMA"]
                                         [:short-opt "-d" "delta"]])
             [{:alpha true :beta true :gamma "GAMMA" :delta "delta"} []]))))
  (testing "associates :id and value with :assoc-fn"
    (let [specs (compile-option-specs
                  [["-a" "--alpha"
                    :default true
                    :assoc-fn (fn [m k v] (assoc m k (not v)))]
                   ["-v" "--verbose"
                    :default 0
                    :assoc-fn (fn [m k _] (assoc m k (inc (m k))))]])]
      (is (= (parse-option-tokens specs [])
             [{:alpha true :verbose 0} []]))
      (is (= (parse-option-tokens specs [[:short-opt "-a"]])
             [{:alpha false :verbose 0} []]))
      (is (= (parse-option-tokens specs [[:short-opt "-v"]
                                         [:short-opt "-v"]
                                         [:long-opt "--verbose"]])
             [{:alpha true :verbose 3} []]))
      (is (= (parse-option-tokens specs [[:short-opt "-v"]] :no-defaults true)
             [{:verbose 1} []])))))

(deftest test-summarize
  (testing "summarizes options"
    (is (= (summarize (compile-option-specs
                        [["-s" "--server HOST" "Upstream server"
                          :default :some-object-whose-string-representation-is-awful
                          :default-desc "example.com"]
                         ["-p" "--port=PORT" "Upstream port number"
                          :default 80]
                         ["-o" nil "Output file"
                          :id :output
                          :required "PATH"]
                         ["-v" nil "Verbosity level; may be specified more than once"
                          :id :verbose
                          :default 0]
                         [nil "--ternary t|f|?" "A ternary option defaulting to false"
                          :default false
                          :parse-fn #(case %
                                       "t" true
                                       "f" false
                                       "?" :maybe)]
                         [nil "--help"]]))
           (join \newline
                 ["  -s, --server HOST    example.com  Upstream server"
                  "  -p, --port PORT      80           Upstream port number"
                  "  -o PATH                           Output file"
                  "  -v                                Verbosity level; may be specified more than once"
                  "      --ternary t|f|?  false        A ternary option defaulting to false"
                  "      --help"]))))
  (testing "does not print :default column when no defaults will be shown"
    (is (= (summarize (compile-option-specs [["-b" "--boolean" "A boolean option with a hidden default"
                                              :default true]
                                             ["-o" "--option ARG" "An option without a default"]]))
           (join \newline ["  -b, --boolean     A boolean option with a hidden default"
                           "  -o, --option ARG  An option without a default"]))))
  (testing "works with no options"
    (is (= (summarize (compile-option-specs []))
           ""))))

(deftest test-get-default-options
  (testing "Extracts map of default options from a sequence of option vectors."
    (is (= (get-default-options [[:id :a :default "a"]
                                 [:id :b :default 98]
                                 [:id :c]])
           {:a "a" :b 98}))))

(deftest test-parse-opts
  (testing "parses options to :options"
    (is (= (:options (parse-opts ["-abp80"] [["-a" "--alpha"]
                                             ["-b" "--beta"]
                                             ["-p" "--port PORT"
                                              :parse-fn parse-int]]))
           {:alpha true :beta true :port (int 80)})))
  (testing "collects error messages into :errors"
    (let [specs [["-f" "--file PATH"
                  :validate [#(not= \/ (first %)) "Must be a relative path"]]
                 ["-p" "--port PORT"
                  :parse-fn parse-int
                  :validate [#(< 0 % 0x10000) "Must be between 0 and 65536"]]]
          errors (:errors (parse-opts ["-f" "/foo/bar" "-p0"] specs))]
      (is (has-error? #"Must be a relative path" errors))
      (is (has-error? #"Must be between 0 and 65536" errors))))
  (testing "collects unprocessed arguments into :arguments"
    (is (= (:arguments (parse-opts ["foo" "-a" "bar" "--" "-b" "baz"]
                                   [["-a" "--alpha"] ["-b" "--beta"]]))
           ["foo" "bar" "-b" "baz"])))
  (testing "provides an option summary at :summary"
    (is (re-seq #"-a\W+--alpha" (:summary (parse-opts [] [["-a" "--alpha"]])))))
  (testing "processes arguments in order when :in-order is true"
    (is (= (:arguments (parse-opts ["-a" "foo" "-b"]
                                   [["-a" "--alpha"] ["-b" "--beta"]]
                                   :in-order true))
           ["foo" "-b"])))
  (testing "does not merge over default values when :no-defaults is true"
    (let [option-specs [["-p" "--port PORT" :default 80]
                        ["-H" "--host HOST" :default "example.com"]
                        ["-q" "--quiet" :default true]
                        ["-n" "--noop"]]]
      (is (= (:options (parse-opts ["-n"] option-specs))
             {:port 80 :host "example.com" :quiet true :noop true}))
      (is (= (:options (parse-opts ["-n"] option-specs :no-defaults true))
             {:noop true}))))
  (testing "accepts optional summary-fn for generating options summary"
    (is (= (:summary (parse-opts [] [["-a" "--alpha"] ["-b" "--beta"]]
                                 :summary-fn (fn [specs]
                                               (str "Usage: myprog ["
                                                    (join \| (map :long-opt specs))
                                                    "] arg1 arg2"))))
           "Usage: myprog [--alpha|--beta] arg1 arg2"))))

(comment
  ;; Chas Emerick's PhantomJS test runner
  (spit "target/runner.js"
        (slurp (clojure.java.io/resource "cemerick/cljs/test/runner.js")))

  ;; CLJS test runner; same as `lein cljsbuild test`
  (defn run-cljs-tests []
    (println
      (clojure.java.shell/sh
        "phantomjs"
        "target/runner.js"
        "target/cli_test.js")))
  )
