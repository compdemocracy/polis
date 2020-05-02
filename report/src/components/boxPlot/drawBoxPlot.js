// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import "./lib";

/*********************************************************************
**********************************************************************
                          Draw box plot
**********************************************************************
*********************************************************************/

const drawBoxPlot = (dataset) => {

  // console.log("drawBoxPlot", dataset)

  var labels = true; // show the text labels beside individual boxplots?

  var margin = {top: 30, right: 50, bottom: 70, left: 50};
  var  width = 800 - margin.left - margin.right;
  var height = 400 - margin.top - margin.bottom;

  // var min = Infinity,
  //     max = -Infinity;

  // parse in the data
  // d3.csv("https://gist.githubusercontent.com/jensgrubert/7789216/raw/2d40368c5e8dcc88f26e8e80e2128bd4c2adc942/data.csv", function(error, csv) {
  	// using an array of arrays with
  	// data[n][2]
  	// where n = number of columns in the csv file
  	// data[i][0] = name of the ith column
  	// data[i][1] = array of values of ith column

    /*

  	var data = [];
  	data[0] = [];
  	data[1] = [];
  	data[2] = [];
  	data[3] = [];
  	// add more rows if your csv file has more columns

  	// add here the header of the csv file
  	data[0][0] = "Q1";
  	data[1][0] = "Q2";
  	data[2][0] = "Q3";
  	data[3][0] = "Q4";
  	// add more rows if your csv file has more columns

  	data[0][1] = [];
  	data[1][1] = [];
  	data[2][1] = [];
  	data[3][1] = [];

  	csv.forEach(function(x) {
  		var v1 = Math.floor(x.Q1),
  			v2 = Math.floor(x.Q2),
  			v3 = Math.floor(x.Q3),
  			v4 = Math.floor(x.Q4);
  			// add more variables if your csv file has more columns

        console.log('v1', v1)

  		var rowMax = Math.max(v1, Math.max(v2, Math.max(v3,v4)));
  		var rowMin = Math.min(v1, Math.min(v2, Math.min(v3,v4)));

  		data[0][1].push(v1);
  		data[1][1].push(v2);
  		data[2][1].push(v3);
  		data[3][1].push(v4);
  		 // add more rows if your csv file has more columns

  		if (rowMax > max) max = rowMax;
  		if (rowMin < min) min = rowMin;
  	});

    console.log('parsed looks like ', data)

    */

  	var chart = d3.box()
  		.whiskers(iqr(1.5))
  		.height(height)
  		.domain([0, 100])
  		.showLabels(labels);

  	var svg = d3.select("#boxPlot").append("svg")
  		.attr("width", width + margin.left + margin.right)
  		.attr("height", height + margin.top + margin.bottom)
  		.attr("class", "box")
  		.append("g")
  		.attr("transform", "translate(" + margin.left + "," + margin.top + ")");

      // // the x-axis
    	// var x = d3.scale.ordinal()
    	// 	.domain( data.map(function(d) { console.log(d); return d[0] } ) )
    	// 	.rangeRoundBands([0 , width], 0.7, 0.3);

      var x = d3.scaleBand()
          .domain(dataset.map(function(d) { return d[0] } ))
          .range([0, width])
          .paddingInner(0.7)
          .paddingOuter(0.3)

  	var xAxis = d3.axisBottom()
  		.scale(x)

  	// the y-axis
  	var y = d3.scaleLinear()
  		.domain([0, 100]) /* percent, never truncated */
  		.range([height + margin.top, 0 + margin.top]);

  	var yAxis = d3.axisLeft()
      .scale(y)

  	// draw the boxplots
  	svg.selectAll(".box")
        .data(dataset)
  	  .enter().append("g")
  		.attr("transform", function(d) { return "translate(" +  x(d[0])  + "," + margin.top + ")"; } )
        .call(chart.width(x.bandwidth()));


  	// add a title
  	svg.append("text")
          .attr("x", (width / 2))
          .attr("y", 0 + (margin.top / 2))
          .attr("text-anchor", "middle")
          .style("font-size", "18px")
          //.style("text-decoration", "underline")
          .text(""); // agreement across all comments per group ?

  	 // draw y axis
  	svg.append("g")
          .attr("class", "y axis")
          .call(yAxis)
  		.append("text") // and text1
  		  .attr("transform", "rotate(-90)")
  		  .attr("y", 6)
  		  .attr("dy", ".71em")
  		  .style("text-anchor", "end")
  		  .style("font-size", "16px")
  		  .text("Revenue in €");

  	// draw x axis
  	svg.append("g")
        .attr("class", "x axis")
        .attr("transform", "translate(0," + (height  + margin.top + 10) + ")")
        .call(xAxis)
  	  .append("text")             // text label for the x axis
          .attr("x", (width / 2) )
          .attr("y",  10 )
  		.attr("dy", ".71em")
          .style("text-anchor", "middle")
  		.style("font-size", "16px")
          .text("Quarter");

  // Returns a function to compute the interquartile range.
  function iqr(k) {
    return function(d, i) {
      var q1 = d.quartiles[0],
          q3 = d.quartiles[2],
          iqr = (q3 - q1) * k,
          i = -1,
          j = d.length;
      while (d[++i] < q1 - iqr);
      while (d[--j] > q3 + iqr);
      return [i, j];
    };
  }

}

export default drawBoxPlot;
