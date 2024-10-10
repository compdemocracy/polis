#!/usr/bin/env -S bb --classpath bin

(require '[lib.db :as db]
         '[clojure.pprint :as pp]
         '[honey.sql.helpers :as sqlh])

;; Should we delete their conversations as well?
;; assuming leave IP address
;; Should maybe make sure we don't have their IP address from before we started saving encrypted

(defn expunge-record
  [table where attrs]
  (db/execute!
    {:update table
     :where where
     :set (into {} (map #(vector %1 nil) attrs))}))

(defn -main [email]
  (if-let [uid (db/get-email-uid email)]
    (do
      (println "Found uid:" uid)
      (println "Deleting user data:")
      (expunge-record :users [:= :uid uid] [:hname :email])
      (println "Deleting participants_extended data:")
      (expunge-record :participants_extended [:= :uid uid] [:subscribe_email]))
    (println "Could not find uid for email address")))

(when (= *file* (System/getProperty "babashka.file"))
  (apply -main *command-line-args*))


