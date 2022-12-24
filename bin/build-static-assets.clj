#!/usr/bin/env bb

(require '[babashka.pods :as pods]
         '[babashka.deps :as deps]
         '[babashka.process :as process]
         '[clojure.core.async :as async]
         '[clojure.pprint :as pp]
         '[clojure.tools.cli :as cli]
         '[clojure.java.io :as io]
         '[clojure.string :as string])


;; basic example using the process library
;(-> (process/process '[ls -a] {:dir "math"}) :out slurp)

(def timestamp (System/currentTimeMillis))

(defn logged-command [& args]
    (println "Executing command:" (pr-str args))
    (apply process/process args))
  

(defn image-name [client-dir]
  (str "polis/" client-dir))

(defn container-name [client-dir]
  (str "polis-" client-dir "-cp-container-" timestamp))

(defn build-client
  "Build the client container, and give it a unique name"
  [client-dir]
  (logged-command ['docker 'build '-t (image-name client-dir) '.]
                  {:dir client-dir}))


(defn run-client-container
  [client-dir]
  "Run sleep in the client container so that it is running when we try to copy stuff out of it
  (docker cp only works when the container is running)"
  (let [command (concat '[docker run --name]
                        [(container-name client-dir) (image-name client-dir)]
                        ;; we sleep in the container so that it doesn't just shut down immediately, before we
                        ;; copy anything
                        '[sleep 120])]
    (logged-command command {:dir client-dir})))

(defn clean-build
  "Remove local build files"
  [client-dir]
  (logged-command '[rm -fr build] {:dir client-dir}))


(defn build-dir [client-dir]
  (case client-dir
    "client-participation" "/app/dist/"
    "/app/build"))

(defn cp-client
  "Copy contents out of the running docker image"
  [client-dir]
  (logged-command ['docker 'cp (str (container-name client-dir) ":" (build-dir client-dir)) 'build]
                  {:dir client-dir}))

(defn monitor-execution
  "Monitor the execution, and return an error object if the process does not execute properly"
  [proc]
  (let [{:keys [exit out err]} @proc]
    (when (> exit 0)
      (println "PROCESS FAILED TO EXECUTE SUCCESSFULLY!"))
    (println "Exit status:" exit)
    (let [out-str (slurp out)
          err-str (slurp err)]
      (when-not (empty? out-str)
        (println "Std out" out-str))
      (when-not (empty? err-str)
        (println "Std err" err-str)))))

(defn stop-containers
  "Stop the containers, so that we can remove them"
  [client-dir]
  (logged-command ['docker 'stop (container-name client-dir)]))

(defn clean-containers
  "Remove the old container to clean up after ourselves"
  [client-dir]
  (logged-command ['docker 'rm (container-name client-dir)]))
  


(defn build-and-cp-client
  "Build the clients with docker and copy out the assets"
  [client-dir]
  ;; build the client itself, and block till complete
  (monitor-execution (build-client client-dir))
  ;; start client container and let run (should have softer monitoring of this
  (run-client-container client-dir)
  ;; once that is started clean the build dir
  (monitor-execution (build-client client-dir))
  (monitor-execution (clean-build client-dir))
  (monitor-execution (cp-client client-dir))
  (monitor-execution (stop-containers client-dir))
  (monitor-execution (clean-containers client-dir)))
  ;; once that has completed, 

(def processes
  (for [client-dir ["client-admin" "client-participation"]];; "client-report"]] ; leaving client-report off for now
    (async/thread
      (build-and-cp-client client-dir)
      (println "Finished building:" client-dir))))

;; Initiate all of the processes, since for is a lazy list
(doall processes)
;; for each process, wait until the process completes
(doseq [proc processes]
  (async/<!! proc))

;; QED

