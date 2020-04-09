// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from 'react';
import Radium from 'radium';
// import _ from 'lodash';
// import Flex from './framework/flex';
// import { connect } from 'react-redux';
// import { FOO } from '../actions';

// const style = {
// };

// @connect(state => {
//   return state.FOO;
// })
@Radium
class ComponentName extends React.Component {
  constructor(props) {
    super(props);
    this.state = {

    };
  }
  static propTypes = {
    /* react */
    // dispatch: React.PropTypes.func,
    params: React.PropTypes.object,
    routes: React.PropTypes.array,
    /* component api */
    style: React.PropTypes.object,
    // foo: React.PropTypes.string
  }
  static defaultProps = {
    // foo: "bar"
  }
  getStyles() {
    return {
      base: {

      }
    };
  }
  render() {
    const styles = this.getStyles();
    return (
        <svg
          width="20"
          height="20">
          <path
            style={{fill:"#88c9f9"}}
            d={`
              m 14.5436,18.0924 c -0.160467,0 -0.3878,-0.03 -0.682,-0.09 -0.2942,
              -0.06 -0.488133,-0.1102 -0.5818,-0.1506 -0.33428,0.669333 -0.78895,
              1.194767 -1.36401,1.5763 -0.57506,0.381533 -1.216987,0.5723 -1.92578,
              0.5723 -0.7087933,0 -1.3674367,-0.210833 -1.97593,-0.6325 -0.6084933,
              -0.421733 -1.0331,-0.9271 -1.27382,-1.5161 -0.4145733,
              0.160667 -0.8425233,0.241 -1.28385,0.241 -1.0030067,0 -1.8589067,
              -0.3782 -2.5677,-1.1346 -0.7087933,-0.756333 -1.0565033,
              -1.6499 -1.04313,-2.6807 -0.0134,-0.04 -0.0134,-0.08017 0,
              -0.1205 l 0,-0.1205 c -0.0134,-0.04013 -0.0134,-0.08028 0,
              -0.12044 0.0134,-0.04013 0.0134,-0.08029 0,-0.12048 C 1.27052,
              13.420747 0.81916333,12.942167 0.49151,12.35984 0.16383667,
              11.77724 0,11.147923 0,10.47189 0,9.79585 0.17719667,9.1398933 0.53159,
              8.50402 0.88599,7.86814 1.39084,7.3828633 2.04614,7.04819 L 1.96594,
              6.72691 C 1.8857,6.5261033 1.84558,6.2985267 1.84558,6.04418 1.8188467,
              5.93708 1.8188467,5.82329 1.84558,5.70281 1.83218,4.68541 2.1732033,
              3.7951833 2.86865,3.03213 3.56407,2.2690767 4.4266567,1.88755 5.45641,
              1.88755 c 0.4413267,0 0.8692767,0.08032 1.28385,0.24096 C 6.9943533,
              1.5261033 7.4156167,1.02075 8.00405,0.61245 8.5924567,0.20415 9.25443,
              0 9.98997,0 c 1.47108,0 2.56769,0.70950333 3.28983,2.12851 0.3544,
              -0.16064 0.775667,-0.24096 1.2638,-0.24096 1.003,0 1.855567,
              0.3748333 2.5577,1.1245 0.702133,0.7496667 1.066567,1.6465867 1.0933,
              2.69076 -0.01333,0.08032 -0.02,0.19411 -0.02,0.34137 l -0.1203,
              0.68273 c -0.02667,0.12048 -0.0668,0.2275733 -0.1204,0.32128 0.6018,
              0.2811267 1.089933,0.7195467 1.4644,1.31526 0.374467,0.59572 0.575067,
              1.2951867 0.6018,2.0984 -0.02667,0.749667 -0.2072,1.41901 -0.5416,
              2.00803 -0.334333,0.58902 -0.775667,1.030787 -1.324,1.3253 0.02667,
              0.05353 0.04,0.09369 0.04,0.12048 l 0.02,0.24094 c -0.02667,
              0.04 -0.02667,0.08017 0,0.1205 -0.02667,1.070933 -0.394433,
              1.974567 -1.1033,2.7109 -0.7088,0.736267 -1.558033,1.1044 -2.5477,
              1.1044`}
            />
          <path
            style={{fill:"#ffffff"}}
            d={`
              M 13.2598,6.58635 8.42528,11.40562 6.76028,9.71888 C 6.51956,
              9.5180733 6.28218,9.41767 6.04814,9.41767 5.8141067,
              9.41767 5.5633567,9.5180733 5.29589,9.71888 5.0952833,
              10 4.9983267,10.271083 5.00502,10.53213 c 0.00667,0.26104 0.11031,
              0.471883 0.31093,0.63253 l 2.38716,2.40964 c 0.24072,
              0.2008 0.5015033,0.3012 0.78235,0.3012 0.28084,0 0.5015,
              -0.1004 0.66198,-0.3012 l 0.0201,0 5.524341,-5.6675353 C 15.199662,
              7.3478056 14.827995,6.7252711 14.674931,6.5787563 14.521867,
              6.4322415 13.835901,6.0147732 13.2598,6.58635 z
              `}
            />
        </svg>
    );
  }
}

export default ComponentName;

/*

propTypes: {
    // You can declare that a prop is a specific JS primitive. By default, these
    // are all optional.
    optionalArray: React.PropTypes.array,
    optionalBool: React.PropTypes.bool,
    optionalFunc: React.PropTypes.func,
    optionalNumber: React.PropTypes.number,
    optionalObject: React.PropTypes.object,
    optionalString: React.PropTypes.string,

    // Anything that can be rendered: numbers, strings, elements or an array
    // (or fragment) containing these types.
    optionalNode: React.PropTypes.node,

    // A React element.
    optionalElement: React.PropTypes.element,

    // You can also declare that a prop is an instance of a class. This uses
    // JS's instanceof operator.
    optionalMessage: React.PropTypes.instanceOf(Message),

    // You can ensure that your prop is limited to specific values by treating
    // it as an enum.
    optionalEnum: React.PropTypes.oneOf(['News', 'Photos']),

    // An object that could be one of many types
    optionalUnion: React.PropTypes.oneOfType([
      React.PropTypes.string,
      React.PropTypes.number,
      React.PropTypes.instanceOf(Message)
    ]),

    // An array of a certain type
    optionalArrayOf: React.PropTypes.arrayOf(React.PropTypes.number),

    // An object with property values of a certain type
    optionalObjectOf: React.PropTypes.objectOf(React.PropTypes.number),

    // An object taking on a particular shape
    optionalObjectWithShape: React.PropTypes.shape({
      color: React.PropTypes.string,
      fontSize: React.PropTypes.number
    }),

    // You can chain any of the above with `isRequired` to make sure a warning
    // is shown if the prop isn't provided.
    requiredFunc: React.PropTypes.func.isRequired,

    // A value of any data type
    requiredAny: React.PropTypes.any.isRequired,

*/
