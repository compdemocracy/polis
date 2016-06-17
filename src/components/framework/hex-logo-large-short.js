import React from "react";
import Radium from "radium";
import _ from "lodash";
import Flex from "./flex";

@Radium
class PolisLogo extends React.Component {
  styles() {
    return {
      link: {
        textDecoration: "none",
        cursor: "pointer",
        padding: "8px 0px 4px 10px"
      }
    }
  };
  render() {
    return (
        <a style={this.styles().link} href="http://pol.is">
        <svg width="87px" height="100px" viewBox="0 0 87 100" >
            <g id="Page-1" stroke="none" strokeWidth="1" fill="none" fillRule="evenodd">
                <g id="100x100-transparent">
                    <g id="Group">
                        <polygon id="Polygon-1" fill="#03A9F4" points="43.3338275 0 86.6676551 25 86.6676551 75 43.3338275 100 1.85649324e-14 75 -9.34924652e-15 25"></polygon>
                        <path d="M12.406015,29.7520661 L15.7142857,38.0165289" id="Line" stroke="#FFFFFF" strokeWidth="0.3" strokeLinecap="square"></path>
                        <text id="p." fontFamily="Georgia" fontSize="59.1940957" fontWeight="normal" fill="#FFFFFF">
                            <tspan x="25.6390977" y="58.9586777">p.</tspan>
                        </text>
                        <path d="M69.887218,53.3057851 L78.9849624,39.2561983" id="Line" stroke="#FFFFFF" strokeWidth="0.3" strokeLinecap="square"></path>
                        <path d="M59.962406,80.5785124 L68.6466165,74.3801653" id="Line" stroke="#FFFFFF" strokeWidth="0.3" strokeLinecap="square"></path>
                        <path d="M43.0075188,88.4297521 L50.4511278,74.3801653" id="Line" stroke="#FFFFFF" strokeWidth="0.3" strokeLinecap="square"></path>
                        <path d="M8.27067669,64.4628099 L15.7142857,39.6694215" id="Line" stroke="#FFFFFF" strokeWidth="0.3" strokeLinecap="square"></path>
                        <path d="M59.962406,80.5785124 L68.6466165,74.3801653" id="Line" stroke="#FFFFFF" strokeWidth="0.3" strokeLinecap="square"></path>
                        <ellipse id="Oval-17" fill="#FFFFFF" cx="78.9849624" cy="39.2561983" rx="1.2406015" ry="1.23966942"></ellipse>
                        <ellipse id="Oval-17" fill="#FFFFFF" cx="62.443609" cy="30.9917355" rx="1.2406015" ry="1.23966942"></ellipse>
                        <ellipse id="Oval-17" fill="#FFFFFF" cx="11.9924812" cy="29.338843" rx="1.2406015" ry="1.23966942"></ellipse>
                        <ellipse id="Oval-17" fill="#FFFFFF" cx="16.1278195" cy="38.4297521" rx="1.2406015" ry="1.23966942"></ellipse>
                        <ellipse id="Oval-17" fill="#FFFFFF" cx="7.85714286" cy="64.8760331" rx="1.2406015" ry="1.23966942"></ellipse>
                        <ellipse id="Oval-17" fill="#FFFFFF" cx="50.8646617" cy="73.9669421" rx="1.2406015" ry="1.23966942"></ellipse>
                        <ellipse id="Oval-17" fill="#FFFFFF" cx="49.2105263" cy="22.7272727" rx="1.2406015" ry="1.23966942"></ellipse>
                        <ellipse id="Oval-17" fill="#FFFFFF" cx="31.0150376" cy="23.553719" rx="1.2406015" ry="1.23966942"></ellipse>
                        <ellipse id="Oval-17" fill="#FFFFFF" cx="34.3233083" cy="17.768595" rx="1.2406015" ry="1.23966942"></ellipse>
                        <ellipse id="Oval-17" fill="#FFFFFF" cx="42.593985" cy="14.4628099" rx="1.2406015" ry="1.23966942"></ellipse>
                        <ellipse id="Oval-17" fill="#FFFFFF" cx="42.593985" cy="88.8429752" rx="1.2406015" ry="1.23966942"></ellipse>
                        <ellipse id="Oval-17" fill="#FFFFFF" cx="59.962406" cy="80.5785124" rx="1.2406015" ry="1.23966942"></ellipse>
                        <ellipse id="Oval-17" fill="#FFFFFF" cx="59.962406" cy="72.3140496" rx="1.2406015" ry="1.23966942"></ellipse>
                        <ellipse id="Oval-17" fill="#FFFFFF" cx="68.2330827" cy="74.7933884" rx="1.2406015" ry="1.23966942"></ellipse>
                        <path d="M34.3233083,17.768595 L48.7969925,22.3140496" id="Line" stroke="#FFFFFF" strokeWidth="0.3" strokeLinecap="square"></path>
                        <path d="M31.4285714,23.1404959 L33.9097744,18.1818182" id="Line" stroke="#FFFFFF" strokeWidth="0.3" strokeLinecap="square"></path>
                    </g>
                </g>
            </g>
        </svg>
        </a>
    );
  }
}

export default PolisLogo;
