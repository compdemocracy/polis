#!/usr/bin/env -S bb --classpath bin

(require '[lib.db :as db]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def batch-size 50)

(defn xid-seq [filename]
  (map
    (fn [line] (first (str/split line #",")))
    (line-seq (io/reader filename))))

(defn xid-record [owner xid]
  {:owner owner
   :xid xid})

(defn resolve-owner-id [{:as opts-map :strs [--owner --owner-email]}]
  (if --owner
    (Integer/parseInt --owner)
    (db/get-email-uid --owner-email)))

(defn -main [& {:as opts-map :strs [--owner --owner-email --xid-file]}]
  (let [xids (xid-seq --xid-file)
        owner-id (resolve-owner-id opts-map)]
    (loop [xids-batch (take batch-size xids)
           xids-rest (drop batch-size xids)]
      (db/upsert! :xid_whitelist
                  :xid_whitelist_owner_xid_key
                  (map (fn [xid]
                         (xid-record owner-id xid)) ; process xid
                       xids-batch))
      (when (seq xids-rest)
        (recur (take batch-size xids-rest)
               (drop batch-size xids-rest))))
    (println "Done")))


(when (= *file* (System/getProperty "babashka.file"))
  (apply -main *command-line-args*))


