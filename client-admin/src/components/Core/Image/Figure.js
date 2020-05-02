import React from "react";
import PropTypes from "prop-types";

const Figure = ({ src, height, width, className}) => {
  
  return (
    <figure className={className}>
        <img src={src} height={height}  />
      </figure>
  );
};

Figure.PropTypes = {
  src: PropTypes.string.isRequired,
  height : PropTypes.string,
  width : PropTypes.string,
  className: PropTypes.string
}

export default Figure;
