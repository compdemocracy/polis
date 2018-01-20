import React from "react";
import PropTypes from "prop-types";

const Figure = ({ src, className}) => {
  return (
     <figure className={className}>
        <img src={src} className="br-100" />
      </figure>
  );
};

Figure.propTypes = {
  src: PropTypes.string.isRequired,
  className: PropTypes.string
};

export default Figure;
