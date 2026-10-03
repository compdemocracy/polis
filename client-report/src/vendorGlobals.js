// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

// The report used to load d3 v4, d3-scale-chromatic v1 and Plotly from CDN
// <script> tags, which defined window.d3 and window.Plotly. The graph code
// still reads those globals (and the unit tests stub them), so this module
// bundles the same versions from npm and sets the same globals. It must be
// the first import in src/index.js so the globals exist before any
// component module runs.
import * as d3 from "d3";
import * as d3ScaleChromatic from "d3-scale-chromatic";
import Plotly from "plotly.js-dist-min";

// The d3-scale-chromatic UMD script added its exports onto the d3 global;
// keep that shape.
// d3.event is a live binding in d3 v4 (set during event dispatch), so keep it
// a getter rather than a copy taken at load time.
window.d3 = Object.assign({}, d3, d3ScaleChromatic);
Object.defineProperty(window.d3, "event", { get: () => d3.event });
window.Plotly = Plotly;
