import React from "react";
import PropTypes from "prop-types";

const Figure = ({ src, height, width, className}) => {
  return (
     <figure className={className}>
        <img src={src} height={height}  />
      </figure>
  );
};

Figure.propTypes = {
  src: PropTypes.string.isRequired,
  className: PropTypes.string
};

export default Figure;
