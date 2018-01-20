import React from "react";
import PropTypes from "prop-types";
  
import Figure from "../Image/Figure"

const PropItem = ({ headline, teaser }) => {

  return (
    <article className="flex-column w-100 w-50-ns ph4 ph0-ns pr5-l mb5">
      <Figure
        src="http://via.placeholder.com/75x75"
      />
      <div className="">
        <h4 className="ttc">{headline}</h4>
        <p>{teaser}</p>
      </div>
    </article>
  );
};

PropItem.propTypes = {
  src: PropTypes.string.isRequired,
  headline: PropTypes.string.isRequired,
  headline: PropTypes.string.isRequired
};

export default PropItem;
