;; Copyright Jason Wolfe and Prismatic, 2013.
;; Licensed under the EPL, same license as Clojure
(ns plumbing-viz
  (:require [clojure.java.shell :as shell]
            [clojure.string :as str]
            [plumbing.core :as plumb]))
;(use 'plumbing.core)

(import '[java.util HashSet] '[java.io File])

(defn double-quote [s] (str "\"" s "\""))

(defn- attribute-string [label-or-attribute-map]
  (when label-or-attribute-map
    (str "["
   (str/join "," 
	   (map (fn [[k v]] (str (name k) "=" v))
		(if (map? label-or-attribute-map) 
		  label-or-attribute-map
		  {:label (double-quote label-or-attribute-map)})))
	 "]")))
      
(defn- walk-graph [root node-key-fn node-label-fn edge-child-pair-fn ^HashSet visited indexer]
  (let [node-key  (node-key-fn root)
	node-map (node-label-fn root)]
    (when-not (.contains visited node-key)
      (.add visited node-key)
      (apply str
	     (indexer node-key) (attribute-string node-map) ";\n"
	     (apply concat 
	       (for [[edge-map child] (edge-child-pair-fn root)]
		 (cons (str (indexer node-key) " -> " (indexer (node-key-fn child)) 
			    (attribute-string edge-map)
			    ";\n")
		       (walk-graph child node-key-fn node-label-fn edge-child-pair-fn visited indexer))))))))


(defn write-graphviz [file-stem roots node-key-fn node-label-fn edge-child-pair-fn] 
  (let [dot-file (str file-stem ".dot")
        svg-file (str file-stem ".svg")
        indexer (memoize (fn [x] (double-quote (gensym))))
        vis      (HashSet.)]
    (spit dot-file
          (str "strict digraph {\n"
               " rankdir = TB;\n"
               (apply str (for [root roots] (walk-graph root node-key-fn node-label-fn edge-child-pair-fn vis indexer)))
               "}\n"))
    (shell/sh "dot" "-Tsvg" "-o" svg-file dot-file)
    svg-file))

(defn graphviz-el [file-stem edge-list]
  (let [edge-map (plumb/map-vals #(map second %) (group-by first edge-list))]
    (write-graphviz
     file-stem
     (set (apply concat edge-list))
     identity identity #(for [e (get edge-map %)] [nil e]))))

(defn graph-edges [g]
  (for [[k node] g
        ;parent (keys (plumbing.fnk.pfnk/input-schema node))
        parent (keys (plumbing.fnk.schema/explicit-schema-key-map
                       (plumbing.fnk.pfnk/input-schema node)))]
     [parent k]))

(defn graphviz-graph
  "Generate file-stem.dot and file-stem.svg representing the nodes and edges of Graph g"
  [file-stem g]
  (graphviz-el file-stem (graph-edges g)))

(require '[polismath.math.conversation :as conv])

;(graphviz-graph "conv-comp-graph2" conv/base-conv-update-graph)
;(graphviz-graph "conv-comp-graph3" conv/small-conv-update-graph)
(graphviz-graph "conv-comp-graph6" (dissoc conv/small-conv-update-graph
                                           :subgroup-ptpt-stats
                                           :subgroup-k-smoother
                                           :subgroup-clusters
                                           :subgroup-votes
                                           :subgroup-repness
                                           :subgroup-clusterings-silhouettes
                                           :subgroup-clusterings))

; zid, participant_count, context, parent_url
;(shell/sh "dot" "-Tsvg" "-o" "conv-comp-graph.svg" "/tmp/conv-comp-graph.dot")
;(graphviz-graph "/tmp/foobar" {:x (plumb/fnk [a]) :y (plumb/fnk [a x])})
;; then check /tmp/foobar.svg
