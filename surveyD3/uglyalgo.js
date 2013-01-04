var people = nodes that mike outputted in some form...;
var rows = all csv rows attached to those nodes;
comparisonobject = {};

for (i=0; i<people.length; i++) {


	for (i=0; i<row.length; i++){

		if (currentperson answer at [i] === comparisonperson answer at [i]) {
			return comparisonobject.currentperson.currentcomparisonperson += 0; //net agreement, do not add
		} else {
			return comparisonobject.currentperson.currentcomparisonperson += 1; //add to net disagreement
		};

	};


};






outputted data structure from uglyalgo will look like this:

comparisonobject = {

	person1: {
		person2: 20,
		person3: 30,
		person4: 14,
		person5: 12,
		person6: etc.

	},

	person2: {
		person1: 34,
		person2: 0,
		person3: 22,
	}

}


Possibility 1: 

CHARGE will define the distance between separate force graphs and be a function of the net difference between 
	all nodes in one graph with all nodes in another graph
LINKS(edges) will be applied conditionally between those nodes on with [some threshold of similarity between themselves] and 
	not between others. might that show bridge individuals who have hte least disagreement with both parties? interesting thought.
ALPHA will be normal
TICKS will be normal
GRAVITY will be normal


Possibility 2: 

CHARGE will be normal and just separate collisions between nodes
LINKS will be ommitted
ALPHA will move nodes to different points of 
GRAVITY of which there will be multiple [x,y] coordinates for [calculated on some metric]
TICKS will define the motion of nodes towards those gravity points while alpha has a value.















