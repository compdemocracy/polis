#!/usr/bin/env bb
;; The 2021 ledger idea continues in polis-migrate. Do not replay all SQL here.
(require '[babashka.process :as process])
(let [result @(process/process ["bash" "server/bin/run-migrations.sh"] {:inherit true})]
  (System/exit (:exit result)))
