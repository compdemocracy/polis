;; Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.darwin.export
  (:require [taoensso.timbre.profiling :as profiling
             :refer (pspy pspy* profile defnp p p*)]
            [clojure.java.io :as io]
            [korma.core :as ko]
            [korma.db :as kdb]
            [polismath.components.postgres :as db]
    ;; Probably should move the function we need out, since this should be meta only XXX
            [polismath.meta.microscope :as micro]
            [polismath.math.clusters :as clust]
            [polismath.math.named-matrix :as nm]
            [polismath.math.conversation :as conv]
            [polismath.utils :as utils]
            [clojure.math.numeric-tower :as math]
            [clojure.core.matrix :as mat]
            [clj-time.core :as t]
            [clj-time.coerce :as co]
    ;; Think I'm going to use the second one here, since it's simpler (less mutable)
            [dk.ative.docjure.spreadsheet :as spreadsheet]
            [clj-excel.core :as excel]
            [semantic-csv.core :as scsv]
            [clojure-csv.core :as csv]
            [clojure.pprint :refer [pprint]]
            [clojure.core.matrix :as mat]
            [clojure.tools.trace :as tr]
            [taoensso.timbre :as log]
            [clojure.tools.cli :refer [parse-opts]]
            [polismath.components.postgres :as postgres]
            [polismath.conv-man :as conv-man]
            [plumbing.core :as plmb])
  (:import [java.util.zip ZipOutputStream ZipEntry]))

;(mat/set-current-implementation :vectorz)

;; Here's rougly what we want for data export. We have the following sheets per conversation.
;;
;; Summary:
;; * N Views
;; * N Voters
;; * N Voters "in conv"
;; * N Commenters
;; * N Groups
;; * url
;;
;;
;; Stats History
;; time, votes, comments, unique-hits, voters, commenters
;;
;;
;; Votes (full votes matrix):
;; participant-id, group-id, n-votes, n-comments, n-aggre, n-disagree, <comments...>
;;
;;
;; Comments:
;; cid, author, aggrees, disagrees, mod, text


(defn datetime [timestamp]
  (str (java.util.Date. timestamp)))


(defn full-path [darwin filename]
  (str (or (-> darwin :config :export :temp-dir) "/tmp/")
       filename))


(defn db-spec [darwin]
  (-> darwin :postgres :db-spec))

;; Database calls for various things

(defn get-zids-for-uid
  [darwin uid]
  (map :zid
    (kdb/with-db (db-spec darwin)
      (ko/select "conversations"
        (ko/fields :zid)
        (ko/where {:owner uid})))))



(defn get-zinvite-from-zid
  [darwin zid]
  (->
    (kdb/with-db (db-spec darwin)
      (ko/select "zinvites"
        (ko/fields :zid :zinvite)
        (ko/where {:zid zid})))
    first
    :zinvite))


(defn get-conversation-votes*
  ([darwin zid]
   (kdb/with-db (db-spec darwin)
     (ko/select db/votes
       (ko/where {:zid zid})
       (ko/order [:zid :tid :pid :created] :asc))))
  ([darwin zid final-vote-timestamp]
   (kdb/with-db (db-spec darwin)
     (ko/select db/votes
       (ko/where {:zid zid :created [<= final-vote-timestamp]})
       ; ordering by tid is important, since we rely on this ordering to determine the index within the comps, which needs to correspond to the tid
       (ko/order [:zid :tid :pid :created] :asc)))))

(defn get-conversation-votes
  [darwin & args]
  (->> (apply get-conversation-votes* darwin args)
       ;; Flip the signs on the votes XXX (remove when we switch)
       (map #(update-in % [:vote] (partial * -1)))
       (map #(assoc % :datetime (datetime (:created %))))))


(defn get-conversation-data
  "Return a map with :topic and :description keys"
  [darwin zid]
  (->
    (kdb/with-db (db-spec darwin)
      (ko/select "conversations"
        (ko/fields :zid :topic :description :created)
        (ko/where {:zid zid})))
    first))

(defn get-participation-data*
  ([darwin zid]
   (kdb/with-db (db-spec darwin)
     (ko/select "participants"
       (ko/fields :zid :pid :vote_count :created)
       (ko/where {:zid zid}))))
  ([darwin zid final-timestamp]
   (kdb/with-db (db-spec darwin)
     (ko/select "participants"
       (ko/fields :zid :pid :vote_count :created)
       (ko/where {:zid zid :created [<= final-timestamp]})))))

(defn get-participation-data
  [& args]
  (->> (apply get-participation-data* args)
       (map (fn [data]
              (assoc data :datetime (datetime (:created data)))))))


(defn get-comments-data
  ([darwin zid]
   (kdb/with-db (db-spec darwin)
     (ko/select "comments"
       (ko/fields :zid :tid :pid :txt :mod :created)
       (ko/where {:zid zid}))))
  ([darwin zid final-timestamp]
   (kdb/with-db (db-spec darwin)
     (ko/select "comments"
       (ko/fields :zid :tid :pid :txt :mod :created)
       (ko/where {:zid zid :created [<= final-timestamp]})))))



;; First the summary data
;; ======================

(defn- count-distinct-col
  ([data]
   (->> data distinct count))
  ([f data]
   (->> data (map f) distinct count)))

(defn summary-data
  "Takes in rating matrix and set of all votes, and computes the summary stats for the
  conversation"
  [darwin
   {:keys [n n-cmts group-clusters base-clusters zid rating-mat] :as conv}
   votes
   comments-data
   participants]
  ;; Fire off a bunch of database calls
  (let [zinvite (future (get-zinvite-from-zid darwin zid))
        conv-data (future (get-conversation-data darwin zid))
        ;; Do anything needed with the data to prep
        {:keys [topic description]} @conv-data
        url (str "https://pol.is/" @zinvite)]
    ;; Return the table of stuff to go into excel
    {:topic        topic
     :url          url
     :n-views      (count-distinct-col :pid participants)
     :n-voters     (count-distinct-col :pid votes)
     :n-voters-in  n
     :n-commenters (count-distinct-col :pid comments-data)
     :n-comments   n-cmts
     :n-groups     (count group-clusters)
     :description  description}))

(defn render-summary-with
  "Intended for formatting the summary data's psuedo-headers for either excel or csv. Takes the
  data as produced by summary data, and a key-mapping collection of keys as in the data to header
  names to output, returning a collection of rows to be spit out."
  [data key-mapping]
  (for [[k v] key-mapping]
    [v (get data k)]))



;; Now the history data
;; ====================

(defn merge-histories
  [votes participants comments]
  (sort-by :created
           (mapcat
             (fn [collection tag]
               (map #(assoc % :tag tag) collection))
             [votes participants comments]
             [:vote :participant :comment])))

(defmulti update-history*
  (fn [last-history datom] (:tag datom)))

(defn update-history
  "For stats-history; takes the last history value and updates it with the given record. Delegates
  to a multimethod which dispatches on :tag, to determine what values need to be updated, and how."
  [history datom]
  (conj history
        (-> datom
            (->> (update-history* (or (last history)
                                   {:n-votes 0 :n-comments 0 :n-visitors 0 :n-voters 0 :n-commenters 0 :ctxt {:voters #{}
                                                                                                              :commenters #{}}})))
            (assoc :time (:created datom)))))

(defmethod update-history* :vote
  [last-history datom]
  (-> last-history
      (update-in [:n-votes] inc)
      (update-in [:n-voters]
                 (fn [n-voters] (if-not (get-in datom [:ctxt :voters (:pid datom)])
                                  (inc n-voters)
                                  n-voters)))
      (update-in [:ctxt :voters] conj (:pid datom))))

(defmethod update-history* :participant
  [last-history datom]
  (-> last-history
      (update-in [:n-visitors] inc)))

(defmethod update-history* :comment
  [last-history datom]
  (-> last-history
      (update-in [:n-comments] inc)
      (update-in [:n-commenters]
                 (fn [n-commenters] (if-not (get-in datom [:ctxt :commenters (:pid datom)])
                                      (inc n-commenters)
                                      n-commenters)))
      (update-in [:ctxt :commenters] conj (:pid datom))))

(defn stats-history
  "Returns rows of {time, n-votes, n-comments, n-visitors, n-voters, n-commenters}"
  [votes participants comments]
  (reduce update-history [] (merge-histories votes participants comments)))



;; Full votes matrix (plus some other participant summaries)
;; =================

(defn reconstruct-vote-matrix
  [votes]
  (let [new-nmat (nm/named-matrix)
        vote-tuples (map #(map % [:pid :tid :vote]) votes)]
    (nm/update-nmat new-nmat vote-tuples)))

(defn ffilter
  "Given pred and coll, return the first x in coll for which (pred x) is truthy"
  [pred coll]
  (first (filter pred coll)))

(defn flatten-clusters
  "Takes group clusters and base clusters and flattens them out into a cluster mapping to ptpt ids directly"
  [group-clusters base-clusters]
  (map
    (fn [gc]
      (update-in gc
                 [:members]
                 (fn [members]
                   (mapcat
                     (fn [bid]
                       ;; get the base cluster, then get it's members, mapcat them (a level up)
                       (:members (ffilter #(= (:id %) bid) base-clusters)))
                     members))))
    group-clusters))

;; participant-id, group-id, n-votes, n-comments, n-aggre, n-disagree, <comments...>
(defn participants-votes-table
  [conv votes comments]
  (let [mat (reconstruct-vote-matrix votes)
        flattened-clusters (flatten-clusters (:group-clusters conv) (:base-clusters conv))]
    (concat
      ;; The header
      [(into ["participant" "group-id" "n-comments" "n-votes" "n-agree" "n-disagree"] (nm/colnames mat))]
      ;; The rest of the data
      (map
        (fn [ptpt row]
          (into [ptpt
                 (:id (ffilter #(some #{ptpt} (:members %)) flattened-clusters))
                 (count (filter #(= (:pid %) ptpt) comments))
                 (count (remove nil? row))
                 ;; XXX God damn aggree vs disagree...
                 ;; Fixed this upstream, for now; so should be good to go once we've fixed it at the source. But
                 ;; keep an eye on it for now... XXX
                 (count (filter #{1} row))
                 (count (filter #{-1} row))]
                row))
        (nm/rownames mat)
        (.matrix mat)))))

(defn format-vote-matrix-header
  "Apply format-header function to each element of header in a collection of row vectors"
  [data format-header]
  (concat [(mapv format-header (first data))]
          (rest data)))


;; Comments
;; ========


(defn enriched-comments-data
  "Just adds vote counts to the comments data"
  [comments votes]
  (map
    (fn [{:keys [tid] :as comment-data}]
      (let [comment-votes (filter #(= tid (:tid %)) votes)
            ;; Fixed this upstream, for now; so should be good to go once we've fixed it at the source. But
            ;; keep an eye on it for now... XXX
            aggrees (filter #(= 1 (:vote %)) comment-votes)
            disagrees (filter #(= -1 (:vote %)) comment-votes)]
        (assoc comment-data
               :aggrees (count aggrees)
               :disagrees (count disagrees)
               :datetime (datetime (:created comment-data)))))
    comments))


;; Now some reshaping stuff for excel; mostly just applying headers here
;; Actaul excel things

(defn stringify-keys
  ([m]
   (stringify-keys m #(-> % str (clojure.string/replace ":" ""))))
  ([m f]
   (into {} (map (fn [[k v]]
                   [(if-not (string? k) (f k) k) v])
                 m))))


(defn update-from-map-or-leave
  "Little utility for generating a function that either updates based on a map (closed over) or leaves value unchanged"
  [m]
  (fn [k]
    (if-let [v (get m k)]
      v
      k)))

(defn excel-format
  [export-data]
  (-> export-data
      (update-in [:summary]
                 render-summary-with
                 [[:topic        "Topic"]
                  [:url          "URL"]
                  [:n-views      "Views"]
                  [:n-voters     "Voters"]
                  [:n-voters-in  "Voters (in conv)"]
                  [:n-commenters "Commenters"]
                  [:n-comments   "Comments"]
                  [:n-groups     "Groups"]
                  [:description  "Conversation Description"]])
      (update-in [:stats-history]
                 (partial scsv/vectorize {:header [:n-votes :n-comments :n-visitors :n-voters :n-commenters]
                                          :format-header {:n-votes      "Votes"
                                                          :n-visitors   "Visitors"
                                                          :n-voters     "Voters"
                                                          :n-comments   "Comments"
                                                          :n-commenters "Commenters"}}))
      (update-in [:comments]
                 (partial scsv/vectorize {:header [:created :tid :pid :aggrees :disagrees :mod :txt]
                                          :format-header {:created   "Timestamp"
                                                          :tid       "Comment ID"
                                                          :pid       "Author"
                                                          :aggrees   "Aggrees"
                                                          :disagrees "Disagrees"
                                                          :mod       "Moderated"
                                                          :txt       "Comment body"}}))
      (update-in [:votes]
                 (partial scsv/vectorize {:header [:created :tid :pid :vote]
                                          :format-header {:created   "Timestamp"
                                                          :tid       "Comment ID"
                                                          :pid       "Voter"
                                                          :vote      "Vote"}}))
      (update-in [:participants-votes]
                 format-vote-matrix-header
                 ;; flesh out...
                 (update-from-map-or-leave {"participant" "Participant"
                                            "group-id"    "Group ID"
                                            "n-comments"  "Comments"
                                            "n-votes"     "Votes"
                                            "n-agree"     "Agrees"
                                            "n-disagree"  "Disagrees"}))
      (stringify-keys (array-map :summary "Summary"
                                 :stats-history "Stats History"
                                 :comments "Comments"
                                 :votes "Votes"
                                 :participants-votes "Participants Votes"))))


(defn csv-format
  [export-data]
  (-> export-data
      (update-in [:summary]
                 render-summary-with
                 [[:topic        "topic"]
                  [:url          "url"]
                  [:n-views      "views"]
                  [:n-voters     "voters"]
                  [:n-voters-in  "voters-in-conv"]
                  [:n-commenters "commenters"]
                  [:n-comments   "comments"]
                  [:n-groups     "groups"]
                  [:description  "conversation-description"]])
      (update-in [:stats-history]
                 (partial scsv/vectorize {:header [:n-votes :n-comments :n-visitors :n-voters :n-commenters]}))
      (update-in [:votes]
                 (partial scsv/vectorize {:header [:created :datetime :tid :pid :vote]
                                          :format-header {:created   "timestamp"
                                                          :datetime  "datetime"
                                                          :tid       "comment-id"
                                                          :pid       "voter-id"
                                                          :vote      "vote"}}))
      (update-in [:comments]
                 (partial scsv/vectorize {:header [:created :datetime :tid :pid :aggrees :disagrees :mod :txt]
                                          :format-header {:created   "timestamp"
                                                          :datetime  "datetime"
                                                          :tid       "comment-id"
                                                          :pid       "author-id"
                                                          :aggrees   "agrees"
                                                          :disagrees "disagrees"
                                                          :mod       "moderated"
                                                          :txt       "comment-body"}}))))



;; This zip nonsense is stolen from http://stackoverflow.com/questions/17965763/zip-a-file-in-clojure
(defmacro ^:private with-entry
  [zip entry-name & body]
  `(let [^ZipOutputStream zip# ~zip]
     (.putNextEntry zip# (ZipEntry. ~entry-name))
     ~@body
     (flush)
     (.closeEntry zip#)))

(defn move-to-zip-stream
  [zip-stream input-filename entry-point]
  (with-open [input  (io/input-stream input-filename)]
    (with-entry zip-stream entry-point
      (io/copy input zip-stream))))

(defn print-csv
  [table]
  (->> table
       (map (partial mapv str))
       csv/write-csv
       print))

(defn zipfile-basename
  [filename]
  (-> filename
      (clojure.string/split #"\/")
      last
      (clojure.string/replace #"\.zip$" "")))


;; Must assert .zip in filenames or things will break on unzipping XXX
(defn save-to-csv-zip
  ([filename data]
   (with-open [file (io/output-stream filename)
               zip  (ZipOutputStream. file)]
     (save-to-csv-zip zip (zipfile-basename filename) data)))
  ([zip-stream entry-point-base data]
   (with-open [wrt  (io/writer zip-stream)]
     (binding [*out* wrt]
       (doto zip-stream
         (with-entry (str entry-point-base "/summary.csv")
           (print-csv (:summary data)))
         (with-entry (str entry-point-base "/stats-history.csv")
           (print-csv (:stats-history data)))
         (with-entry (str entry-point-base "/comments.csv")
           (print-csv (:comments data)))
         (with-entry (str entry-point-base "/votes.csv")
           (print-csv (:votes data)))
         (with-entry (str entry-point-base "/participants-votes.csv")
           (print-csv (:participants-votes data))))))))


(defn save-to-excel
  ([filename data]
   (-> (excel/build-workbook data)
       (excel/save filename)))
  ;; Should really change both this and the above to use the .zip filename, and take basename for the main dir
  ;; XXX
  ([zip-stream entry-point data]
   ;; Would be nice if we could write directly to the zip stream, but the excel library seems to be doing
   ;; weird things...
   (let [tmp-file-path (str "tmp/rand-" (rand-int Integer/MAX_VALUE) ".xml")]
     (save-to-excel tmp-file-path data)
     (move-to-zip-stream zip-stream tmp-file-path entry-point))))


;; Putting it all together
;; =======================

(defn kw->int
  [kw]
  (-> kw
      (str)
      (clojure.string/replace ":" "")
      (Integer/parseInt)))

;; Should be using the conv-man to load the conversation if it's already there
(defn load-conv
  [darwin & {:keys [zid zinvite] :as args}]
  (let [zid (or zid (postgres/get-zid-from-zinvite (:postgres darwin) zinvite))]
    (log/debug "Loading conversation" zid)
    (->
      (db/load-conv (:postgres darwin) zid)
      ;; This should be ok here right?
      (conv-man/restructure-json-conv)
      (update-in
        [:repness]
        (partial plmb/map-keys kw->int)))))


(defn get-export-data
  [darwin {:keys [zid zinvite] :as kw-args}]
  (let [zid (or zid (postgres/get-zid-from-zinvite (:postgres darwin) zinvite))
        ;; assert zid
        votes (get-conversation-votes darwin zid)
        comments (enriched-comments-data (get-comments-data darwin zid) votes)
        participants (get-participation-data darwin zid)
        ;; Should factor out into separate function
        conv (utils/apply-kwargs load-conv darwin kw-args)]
    {:votes votes
     :summary (summary-data darwin conv votes comments participants)
     :stats-history (stats-history votes participants comments)
     :participants-votes (participants-votes-table conv votes comments)
     :comments comments}))

(defn get-export-data-at-date
  [darwin {:keys [zid zinvite env-overrides at-date] :as kw-args}]
  (let [zid (or zid (postgres/get-zid-from-zinvite (:postgres darwin) zinvite))
        votes (get-conversation-votes darwin zid at-date)
        conv (assoc (conv/new-conv) :zid zid)
        conv (conv/conv-update conv votes)
        _ (println "Done with conv update")
        comments (enriched-comments-data (get-comments-data darwin zid at-date) votes)
        participants (get-participation-data darwin zid at-date)]
    {:votes votes
     :summary (assoc (summary-data darwin conv votes comments participants) :at-date at-date)
     :stats-history (stats-history votes participants comments)
     :participants-votes (participants-votes-table conv votes comments)
     :comments comments}))



(defn export-conversation
  "This is the main API endpoint for the export functionality. Given either :zid or :zinvite, export data to
  the specified :format and spit results out to :filename. Optionally, a :zip-stream and :entry point may be
  specified, which can be used for biulding up items in a zip file. This is used in export/-main to export all
  convs for a given uid, for example."
  ;; Don't forget env-overrides {:math-env "prod"}; should clean up with system
  [darwin {:keys [zid zinvite format filename zip-stream entry-point env-overrides at-date] :as kw-args}]
  (log/info "Exporting data for zid =" zid ", zinvite =" zinvite)
  (let [export-data (if at-date
                      (get-export-data-at-date darwin kw-args)
                      (get-export-data darwin kw-args))
        [formatter saver] (case format :excel [excel-format save-to-excel] :csv [csv-format save-to-csv-zip])
        formatted (formatter export-data)]
    (if zip-stream
      (if (-> export-data :summary :n-voters (> 0))
        (saver zip-stream entry-point formatted)
        (log/debug "Skipping conv" zid zinvite ", since no votes"))
      (saver (full-path darwin filename) formatted)))
  (log/info "Finished exporting data for zid =" zid ", zinvite =" zinvite))





; A testbench for using the main API function
(comment
  (require '[polismath.runner :as runner])
  (def darwin (:darwin runner/system))
  runner/system
  (export-conversation runner/system
                       {;;:zid 310273
                        :zinvite "7scufp"
                        :format :csv
                        :filename "cljwebdev.zip"
                        :math-env "prod"})
  (export-conversation darwin
                       {;;:zid 310273
                        :zinvite "7scufp"
                        :format :excel
                        :filename "cljwebdev.xlsx"
                        :math-env "prod"})
  :end-comment)


:ok

