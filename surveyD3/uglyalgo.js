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

with regards to our force graph: ... the most basic thing to do is set the link distance (all 4000 of them) based on the number
	of comments disagreed upon IF THAT NUMBER IS BELOW N, where N is , then make the links disappear. 


Possibility 2: 

CHARGE will be normal and just separate collisions between nodes
LINKS will be ommitted
ALPHA will move nodes to different points of 
GRAVITY of which there will be multiple [x,y] coordinates for simply separates the two predefined clusters
TICKS will define the motion of nodes towards those gravity points while alpha has a value.

with regards to slightly smarter clusters, we could do some basic javascript data analysis that would spit out: 


thought leader approach: if you look at each individiuals relationsihp to others there will be a curve for each. assume
	this curve is ordered left to right, lowest disagreement to highest disagreement. the average of the first 50 and the average
	of the last 50 give you the extremes... compare these numbers to find the 4 people with the largest difference... cluster to them.



... but the dat a is SPARSE. that has always been the problem.



this is some code that is a conditional statement within the for loop, and pushes to a new object 


this is some set interval code that simulates the nested for loops only looking for the first 10 random columns, then 20 random 
	different random columns, to simulate comparisons moving through time and how the visualization will update












