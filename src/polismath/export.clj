(ns polismath.export
  (:require [taoensso.timbre.profiling :as profiling
               :refer (pspy pspy* profile defnp p p*)]
            [clojure.java.io :as io]
            [korma.core :as ko]
            [korma.db :as kdb]
            [polismath.db :as db]
            [polismath.utils :as utils]
            [polismath.clusters :as clust]
            [polismath.named-matrix :as nm]
            [polismath.microscope :as micro]
            [clojure.math.numeric-tower :as math]
            ;; Think I'm going to use the second one here, since it's simpler (less mutable)
            [dk.ative.docjure.spreadsheet :as spreadsheet]
            [clj-excel.core :as excel]
            [semantic-csv.core :as scsv]
            [clojure-csv.core :as csv]
            [clojure.pprint :refer [pprint]]
            [clojure.core.matrix :as mat]
            [clojure.tools.trace :as tr])
  (:import [java.util.zip ZipOutputStream ZipEntry]))

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



;; Database calls for various things

(defn get-zinvite-from-zid
  [zid]
  (-> 
    (kdb/with-db (db/db-spec)
      (ko/select "zinvites"
        (ko/fields :zid :zinvite)
        (ko/where {:zid zid})))
    first
    :zinvite))

(defn get-conversation-data
  "Return a map with :topic and :description keys"
  [zid]
  (->
    (kdb/with-db (db/db-spec)
      (ko/select "conversations"
        (ko/fields :zid :topic :description :created)
        (ko/where {:zid zid})))
    first))

(defn get-participation-data
  [zid]
  (kdb/with-db (db/db-spec)
    (ko/select "participants"
      (ko/fields :zid :pid :vote_count :created)
      (ko/where {:zid zid}))))


(defn get-comments-data
  [zid]
  (kdb/with-db (db/db-spec)
    (ko/select "comments"
      (ko/fields :zid :tid :pid :txt :mod :created)
      (ko/where {:zid zid}))))



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
  [{:keys [n n-cmts group-clusters base-clusters zid rating-mat] :as conv}
   votes
   comments-data
   participants]
  ;; Fire off a bunch of database calls
  (let [zinvite (future (get-zinvite-from-zid zid))
        conv-data (future (get-conversation-data zid))
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
                       (:members (some #(= (:id %) bid) base-clusters)))
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
                 (:id (some #(= ptpt (:members %)) flattened-clusters))
                 (count (filter #(= (:pid %) ptpt) comments))
                 (count (remove nil? row))
                 ;; XXX God damn aggree vs disagree...
                 (count (filter #{-1} row))
                 (count (filter #{1} row))]
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
    (fn [{:keys [pid] :as comment-data}]
      (let [comment-votes (filter #(= pid (:pid %)) votes)
            aggrees (filter #(= -1 (:vote %)) comment-votes)
            disagrees (filter #(= 1 (:vote %)) comment-votes)]
        (assoc comment-data :aggrees (count aggrees) :disagrees (count disagrees))))
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
                 (partial scsv/vectorize {:header [:tid :pid :aggrees :disagrees :mod :txt]
                                          :format-header {:tid       "Comment ID"
                                                          :pid       "Author"
                                                          :aggrees   "Aggrees"
                                                          :disagrees "Disagrees"
                                                          :mod       "Moderated"
                                                          :txt       "Comment body"}}))
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
      (update-in [:comments]
                 (partial scsv/vectorize {:header [:tid :pid :aggrees :disagrees :mod :txt]
                                          :format-header {:tid       "comment-id"
                                                          :pid       "author-id"
                                                          :aggrees   "agrees"
                                                          :disagrees "disagrees"
                                                          :mod       "moderated"
                                                          :txt       "comment-body"}}))))



(defn save-to-excel
  [filename data]
  (-> (excel/build-workbook data)
      (excel/save filename)))


;; This zip nonsense is stolen from http://stackoverflow.com/questions/17965763/zip-a-file-in-clojure
(defmacro ^:private with-entry
  [zip entry-name & body]
  `(let [^ZipOutputStream zip# ~zip]
     (.putNextEntry zip# (ZipEntry. ~entry-name))
     ~@body
     (flush)
     (.closeEntry zip#)))


(defn print-csv
  [table]
  (->> table
       (map (partial mapv str))
       csv/write-csv
       print))

(defn save-to-csv-zip
  [filename data]
  (with-open [file (io/output-stream filename)
              zip  (ZipOutputStream. file)
              wrt  (io/writer zip)]
    (binding [*out* wrt]
      (doto zip
        (with-entry "polis-export/summary.csv"
          (print-csv (:summary data)))
        (with-entry "polis-export/stats-history.csv"
          (print-csv (:stats-history data)))
        (with-entry "polis-export/comments.csv"
          (print-csv (:comments data)))
        (with-entry "polis-export/participants-votes.csv"
          (print-csv (:participants-votes data)))))))
  


;; Putting it all together
;; =======================

(defn get-export-data
  [{:keys [zid zinvite env-overrides] :as kw-args}]
  (let [zid (or zid (micro/get-zid-from-zinvite zinvite))
        votes (micro/conv-poll zid)
        comments (enriched-comments-data (get-comments-data zid) votes)
        participants (get-participation-data zid)
        ;; Should factor out into separate function
        conv (utils/apply-kwargs micro/load-conv kw-args)]
    {:summary (summary-data conv votes comments participants)
     :stats-history (stats-history votes participants comments)
     :participants-votes (participants-votes-table conv votes comments)
     :comments comments}))

(defn export-conversation
  ;; Don't forget env-overrides {:math-env "prod"}; should clean up with system
  [{:keys [zid zinvite format filename env-overrides] :as kw-args}]
  (let [export-data (get-export-data kw-args)
        [formatter saver] (case format :excel [excel-format save-to-excel] :csv [csv-format save-to-csv-zip])]
    (saver filename (formatter export-data))))




;; tinkering... pay no attention

(comment
  
  (try
    ;(export-conversation {:zinvite "3phdex2kjf" :format :excel :filename "test.xls" :env-overrides {:math-env "prod"}})
    (export-conversation {:zinvite "3phdex2kjf" :format :csv :filename "test.zip" :env-overrides {:math-env "prod"}})
    (catch Exception e
      (.printStackTrace e)))

  (def co (load-conv :zinvite "3phdex2kjf" :env-overrides {:math-env "prod"}))
  (count (mapcat :members (:base-clusters co)))
  (keys co)
  
  (def zid (micro/get-zid-from-zinvite "3phdex2kjf"))
  (pprint (take 10 (get-comments-data zid)))
  (pprint (take 10 (get-participation-data zid)))

  (keys c)
  (:group-clusters c)

  (require '[polismath.microscope :as micro :refer :all])
  (require '[semantic-csv.core :as scsv])
  ;(load-dep 

  (def c (assoc c :rating-mat c-mat))

  (nmat->csv "votes-matrix.csv" c-mat)
  )

:ok

