#!/usr/bin/env -S bb --classpath bin

(require '[lib.db :as db]
         '[clojure.java.io :as io]
         '[clojure.string :as str]
         '[honey.sql.helpers :as sqlh])

(defn resolve-zid [{:as opts-map :strs [--zid --zinvite]}]
  (if --zid
    (Integer/parseInt --zid)
    (db/get-zinvite-zid --zinvite)))

(defn -main [& {:as opts-map :strs [--zid --zinvite]}]
  (let [zid (resolve-zid opts-map)]
    (db/execute!
      (-> (sqlh/update :conversations)
          (sqlh/set {:use_xid_whitelist true})
          (sqlh/where [:= :zid zid])))
    (println "Done")))


(when (= *file* (System/getProperty "babashka.file"))
  (apply -main *command-line-args*))


